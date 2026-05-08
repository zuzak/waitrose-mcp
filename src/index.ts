#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import WaitroseClient from "./waitrose.js";
import { startHttpServer } from "./http-server.js";
import { toolCallsTotal, toolCallDuration, sessionAuthenticated } from "./metrics.js";
import { redactArgs, auditLog } from "./audit.js";

const VERSION = "0.1.0";
const SERVER_NAME = "waitrose-mcp";

const PORT = parseInt(process.env.PORT ?? "8080", 10);

// A single shared client — stateless for anonymous use. Each tool call
// issues a fresh HTTP request; there is no per-session client state.
const client = new WaitroseClient();

// Auth extension point.
// If credentials are provided, log in at startup; otherwise remain
// anonymous (the upstream client falls back to customerId "-1" for
// anonymous product search and browse). Authenticated tools (trolley
// management etc) are not implemented yet — when they are, they should
// check client.isAuthenticated() and return a clear "not authenticated"
// error when it is false.
const username = process.env.WAITROSE_USERNAME;
const password = process.env.WAITROSE_PASSWORD;

if (username && password) {
  try {
    await client.login(username, password);
    sessionAuthenticated.set(1);
    console.error(`[INIT] Authenticated as ${username}`);
  } catch (err) {
    console.error("[INIT] Login failed:", err);
    process.exit(1);
  }
} else {
  sessionAuthenticated.set(0);
  console.error("[INIT] Running anonymously (no WAITROSE_USERNAME/WAITROSE_PASSWORD)");
}

const SORT_BY_VALUES = [
  "RELEVANCE",
  "PRICE_LOW_2_HIGH",
  "PRICE_HIGH_2_LOW",
  "A_2_Z",
  "Z_2_A",
  "TOP_RATED",
  "MOST_POPULAR",
  "CATEGORY_RANKING",
] as const;

function safeJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return JSON.stringify({ error: "Failed to serialise response" });
  }
}

function toolError(message: string) {
  return {
    content: [{ type: "text", text: safeJson({ error: message }) }],
    isError: true,
  };
}

// Per-session Server factory. The @modelcontextprotocol/sdk Server class
// can only be connected to one transport at a time; connecting the same
// instance to multiple transports throws "Already connected to a transport".
// claude.ai creates a new MCP session per conversation, so each session
// needs its own Server. Tool handlers themselves are stateless, so
// creating new handlers per session is cheap.
function createMcpServer(): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_products",
        description:
          "Search Waitrose products by free-text query. Returns product names, prices, sizes, and other details. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search term, e.g. 'feta' or 'organic milk'",
            },
            sortBy: {
              type: "string",
              enum: SORT_BY_VALUES,
              description: "Sort order (default: RELEVANCE)",
            },
            size: {
              type: "number",
              description: "Number of results (default: 24, max: 128)",
            },
            start: {
              type: "number",
              description: "Pagination offset, 0-based (default: 0)",
            },
            filterTags: {
              type: "array",
              description:
                "Optional filters, each { group, value } e.g. { group: 'dietary', value: 'vegan' }",
              items: {
                type: "object",
                properties: {
                  group: { type: "string" },
                  value: { type: "string" },
                },
                required: ["group", "value"],
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "browse_products",
        description:
          "Browse Waitrose products by category path. Returns products in that category. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                "Category path, e.g. 'groceries/bakery/bread' or 'groceries/dairy'",
            },
            sortBy: {
              type: "string",
              enum: SORT_BY_VALUES,
              description: "Sort order (default: RELEVANCE)",
            },
            size: {
              type: "number",
              description: "Number of results (default: 24, max: 128)",
            },
            start: {
              type: "number",
              description: "Pagination offset, 0-based (default: 0)",
            },
          },
          required: ["category"],
        },
      },
      {
        name: "get_products_by_line_numbers",
        description:
          "Look up specific Waitrose products by their line number(s). Returns full product details. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            lineNumbers: {
              type: "array",
              description: "One or more Waitrose product line numbers",
              items: { type: "string" },
            },
          },
          required: ["lineNumbers"],
        },
      },
      {
        name: "get_promotion_products",
        description:
          "List Waitrose products on a given promotion. Works without authentication.",
        inputSchema: {
          type: "object",
          properties: {
            promotionId: {
              type: "string",
              description: "Promotion identifier",
            },
            sortBy: {
              type: "string",
              enum: SORT_BY_VALUES,
              description: "Sort order (default: RELEVANCE)",
            },
            size: {
              type: "number",
              description: "Number of results (default: 24, max: 128)",
            },
            start: {
              type: "number",
              description: "Pagination offset, 0-based (default: 0)",
            },
          },
          required: ["promotionId"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const sessionId = (request as any)._meta?.sessionId ?? "unknown";
    const startMs = Date.now();
    const endTimer = toolCallDuration.startTimer({ tool: toolName });

    const finish = (outcome: "ok" | "error" | "denied", errorMsg?: string) => {
      endTimer();
      toolCallsTotal.inc({ tool: toolName, outcome });
      auditLog({
        audit: true,
        ts: new Date().toISOString(),
        session: sessionId,
        tool: toolName,
        args: redactArgs(toolName, args),
        outcome,
        duration_ms: Date.now() - startMs,
        ...(errorMsg ? { error: errorMsg } : {}),
      });
    };

    try {
      let result: { content: Array<{ type: string; text: string }> };

      switch (toolName) {
        case "search_products": {
          const query = args.query;
          if (typeof query !== "string" || !query) {
            throw new McpError(ErrorCode.InvalidParams, "query is required");
          }
          const data = await client.searchProducts(query, {
            sortBy: args.sortBy as any,
            size: args.size as number | undefined,
            start: args.start as number | undefined,
            filterTags: args.filterTags as any,
          });
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "browse_products": {
          const category = args.category;
          if (typeof category !== "string" || !category) {
            throw new McpError(ErrorCode.InvalidParams, "category is required");
          }
          const data = await client.browseProducts(category, {
            sortBy: args.sortBy as any,
            size: args.size as number | undefined,
            start: args.start as number | undefined,
          });
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "get_products_by_line_numbers": {
          const lineNumbers = args.lineNumbers;
          if (
            !Array.isArray(lineNumbers) ||
            lineNumbers.length === 0 ||
            !lineNumbers.every((n) => typeof n === "string")
          ) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "lineNumbers must be a non-empty array of strings",
            );
          }
          const data = await client.getProductsByLineNumbers(lineNumbers as string[]);
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        case "get_promotion_products": {
          const promotionId = args.promotionId;
          if (typeof promotionId !== "string" || !promotionId) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "promotionId is required",
            );
          }
          const data = await client.getPromotionProducts(promotionId, {
            sortBy: args.sortBy as any,
            size: args.size as number | undefined,
            start: args.start as number | undefined,
          });
          result = { content: [{ type: "text", text: safeJson(data) }] };
          break;
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${toolName}`,
          );
      }

      finish("ok");
      return result;
    } catch (err) {
      if (err instanceof McpError) {
        finish("error", err.message);
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] Tool ${toolName} failed:`, msg);
      finish("error", msg);
      return toolError(msg);
    }
  });

  server.onerror = (error) => console.error("[MCP Error]", error);

  return server;
}

process.on("SIGINT", () => {
  process.exit(0);
});

startHttpServer(createMcpServer, PORT, { name: SERVER_NAME, version: VERSION });

console.error(`[INIT] ${SERVER_NAME} v${VERSION} listening on port ${PORT}`);
