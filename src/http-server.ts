import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import cors from "cors";
import http from "node:http";
import { randomUUID } from "node:crypto";

interface ServerInfo {
  name: string;
  version: string;
}

// Patch transport.send() to fall back to the GET SSE stream when the POST
// connection has closed. Adapted from mcp-grocy-api (saya6k/mcp-grocy-api)
// which had to work around claude.ai's behaviour of closing the POST
// before the response is ready, expecting responses on the GET SSE.
function patchTransportSend(
  transport: StreamableHTTPServerTransport,
  pendingResponses: Map<string, unknown[]>,
) {
  const anyTransport = transport as any;
  const original = anyTransport.send.bind(transport);
  anyTransport.send = async (message: unknown, options?: unknown) => {
    try {
      await original(message, options);
    } catch (error: any) {
      if (error?.message?.includes("No connection established for request ID")) {
        const standaloneSseId: string = anyTransport._standaloneSseStreamId;
        const sseStream = anyTransport._streamMapping?.get(standaloneSseId);

        if (sseStream && !sseStream.writableEnded) {
          console.error("[FALLBACK] POST closed — routing response to GET SSE");
          sseStream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
          return;
        }

        const sessionId = transport.sessionId;
        if (sessionId) {
          console.error(`[FALLBACK] No GET SSE — buffering for session ${sessionId}`);
          if (!pendingResponses.has(sessionId)) pendingResponses.set(sessionId, []);
          pendingResponses.get(sessionId)!.push(message);
          return;
        }

        console.error(`[FALLBACK] No session ID — response dropped: ${error.message}`);
        return;
      }
      throw error;
    }
  };
}

export function startHttpServer(
  mcpServer: Server,
  port: number,
  info: ServerInfo,
): http.Server {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "OPTIONS"],
      allowedHeaders: [
        "Origin",
        "X-Requested-With",
        "Content-Type",
        "Accept",
        "Mcp-Session-Id",
        "Authorization",
      ],
      exposedHeaders: ["Mcp-Session-Id", "Content-Type"],
      optionsSuccessStatus: 200,
    }),
  );

  // Dedicated healthz endpoint for k8s probes and meaningful curl checks.
  // The MCP endpoint at /mcp cannot serve a plain GET probe — it opens an
  // SSE stream — so health needs its own route.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: info.name, version: info.version });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: info.name,
      version: info.version,
      endpoints: { mcp: "/mcp", health: "/healthz" },
    });
  });

  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const pendingResponses: Map<string, unknown[]> = new Map();

  // GET /mcp — SSE channel: fallback response delivery + keepalive.
  app.get("/mcp", (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({ error: "Missing Mcp-Session-Id header" });
      return;
    }

    const transport = transports[sessionId];
    if (!transport) {
      res.status(404).json({ error: `Session not found: ${sessionId}` });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Mcp-Session-Id", sessionId);
    res.flushHeaders();

    const anyTransport = transport as any;
    const standaloneSseId: string = anyTransport._standaloneSseStreamId;
    if (standaloneSseId) {
      anyTransport._streamMapping?.set(standaloneSseId, res);
    }

    const pending = pendingResponses.get(sessionId);
    if (pending?.length) {
      console.error(`[FALLBACK] Flushing ${pending.length} buffered response(s)`);
      for (const message of pending) {
        if (!res.writableEnded) {
          res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
        }
      }
      pendingResponses.delete(sessionId);
    }

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, 30000);

    res.on("close", () => {
      clearInterval(keepalive);
      if (standaloneSseId) {
        const current = anyTransport._streamMapping?.get(standaloneSseId);
        if (current === res) anyTransport._streamMapping?.delete(standaloneSseId);
      }
    });
  });

  // POST /mcp — main request channel (streamable HTTP transport).
  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const clientSessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;

      const accept = req.headers.accept || "";
      if (!accept.includes("application/json") && !accept.includes("text/event-stream")) {
        res.status(406).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Not Acceptable: must accept application/json or text/event-stream",
          },
          id: req.body?.id ?? null,
        });
        return;
      }

      if (clientSessionId) {
        transport = transports[clientSessionId];
        if (!transport) {
          const isInitialize = req.body?.method === "initialize";
          if (!isInitialize) {
            res.status(404).json({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Session not found: ${clientSessionId}. Please re-initialize.`,
              },
              id: req.body?.id ?? null,
            });
            return;
          }
        }
      }

      if (!transport) {
        const newSessionId = randomUUID();

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sid: string) => {
            console.error(`[MCP] Session initialized: ${sid}`);
          },
          enableJsonResponse: true,
        });

        patchTransportSend(transport, pendingResponses);

        transports[newSessionId] = transport;

        transport.onclose = () => {
          const closedId = transport?.sessionId || newSessionId;
          console.error(`[MCP] Session closed: ${closedId}`);
          delete transports[closedId];
          pendingResponses.delete(closedId);
        };

        await mcpServer.connect(transport);
      }

      if (transport.sessionId) {
        res.setHeader("Mcp-Session-Id", transport.sessionId);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("[ERROR] POST /mcp failed:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
          },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  const server = http.createServer(app);
  server.on("error", (error) => {
    console.error(`[ERROR] HTTP server error: ${error.message}`);
  });
  server.listen(port, () => {
    console.error(`[HTTP] Listening on port ${port} — /mcp, /healthz`);
  });
  return server;
}
