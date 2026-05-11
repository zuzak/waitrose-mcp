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
import { CapError } from "./safety.js";
import { DeniedError } from "./rate-limiter.js";
import { dispatchTrolleyTool, isTrolleyTool } from "./trolley-tools.js";
import { dispatchAccountTool, isAccountTool } from "./account-tools.js";

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
        name: "list_categories",
        description:
          "List the sub-categories under a Waitrose browse path — useful for discovering the taxonomy before calling browse_products. Returns each child category's display name, slugified browse path, numeric category id, and product count. Call with no path (or 'groceries') for the top-level aisles.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "Browse path under /ecom/shop/browse (default: 'groceries' for the top-level aisles). Pass a previously-returned `path` value to drill in.",
            },
          },
        },
      },
      {
        name: "browse_products",
        description:
          "Browse Waitrose products by category path. Returns products in that category. Works without authentication. Use list_categories first if the right path isn't known.",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description:
                "Category path, e.g. 'groceries/bakery/bread' or 'groceries/dairy'. Use list_categories to discover valid paths.",
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
      {
        name: "get_trolley",
        description:
          "Get the current trolley (basket) — items, totals, and whether the £40 minimum-spend threshold is met. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "add_to_trolley",
        description:
          "Add a single product (by Waitrose line number) to the active trolley. Returns the updated trolley state. Requires authentication. Refused if quantity meets WAITROSE_MAX_QTY_PER_LINE, or if pre-state basket totals meet the configured caps.",
        inputSchema: {
          type: "object",
          properties: {
            lineNumber: {
              type: "string",
              description: "Waitrose product line number",
            },
            quantity: {
              type: "number",
              description: "Quantity to set on this line (replacement, not delta). Default: 1",
            },
            uom: {
              type: "string",
              enum: ["C62", "KGM", "GRM"],
              description: "Unit of measure: C62 (each, default), KGM (kilograms), GRM (grams)",
            },
          },
          required: ["lineNumber"],
        },
      },
      {
        name: "remove_from_trolley",
        description:
          "Remove a single line from the active trolley. Returns the updated trolley state. Requires authentication.",
        inputSchema: {
          type: "object",
          properties: {
            lineNumber: {
              type: "string",
              description: "Waitrose product line number to remove",
            },
          },
          required: ["lineNumber"],
        },
      },
      {
        name: "update_trolley_items",
        description:
          "Bulk update trolley lines — set quantity (0 to remove) for one or more line numbers in a single call. Replacement semantics, not additive. Requires authentication. Refused if any input quantity meets WAITROSE_MAX_QTY_PER_LINE, or if pre-state basket totals meet the configured caps.",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              description: "List of items to set on the trolley",
              items: {
                type: "object",
                properties: {
                  lineNumber: { type: "string" },
                  quantity: { type: "number", description: "Set 0 to remove the line" },
                  uom: {
                    type: "string",
                    enum: ["C62", "KGM", "GRM"],
                    description: "Default: C62",
                  },
                  noteToShopper: { type: "string" },
                  canSubstitute: { type: "boolean" },
                },
                required: ["lineNumber", "quantity"],
              },
            },
          },
          required: ["items"],
        },
      },
      {
        name: "empty_trolley",
        description:
          "Empty the entire trolley. Returns the (now empty) trolley state. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_shopping_context",
        description:
          "Get the current shopping session context — customer ID, active order ID, order state, and default branch. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_account_info",
        description:
          "Get the authenticated customer's account profile and myWaitrose membership details. Requires authentication.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_campaigns",
        description:
          "List active Waitrose marketing campaigns (promotional periods with start/end dates). Requires authentication.",
        inputSchema: { type: "object", properties: {} },
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
        ...(errorMsg && outcome === "denied" ? { denied: errorMsg } : {}),
        ...(errorMsg && outcome === "error" ? { error: errorMsg } : {}),
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

        case "list_categories": {
          const path = args.path;
          if (path !== undefined && (typeof path !== "string" || !path)) {
            throw new McpError(ErrorCode.InvalidParams, "path must be a non-empty string when provided");
          }
          const data = await client.getCategoryNavigation(path as string | undefined);
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
          if (isTrolleyTool(toolName)) {
            const data = await dispatchTrolleyTool(client, toolName, args);
            result = { content: [{ type: "text", text: safeJson(data) }] };
            break;
          }
          if (isAccountTool(toolName)) {
            const data = await dispatchAccountTool(client, toolName, args);
            result = { content: [{ type: "text", text: safeJson(data) }] };
            break;
          }
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
      if (err instanceof CapError || err instanceof DeniedError) {
        const msg = err.message;
        finish("denied", msg);
        return toolError(msg);
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
