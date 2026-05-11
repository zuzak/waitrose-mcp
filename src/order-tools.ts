import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "./waitrose.js";
import type { Order, OrderDetails } from "./waitrose.js";

export type OrderToolName =
  | "get_pending_orders"
  | "get_previous_orders"
  | "get_order"
  | "cancel_order"
  | "initiate_amend_order"
  | "cancel_amend_order";

const ORDER_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_pending_orders",
  "get_previous_orders",
  "get_order",
  "cancel_order",
  "initiate_amend_order",
  "cancel_amend_order",
]);

export function isOrderTool(name: string): name is OrderToolName {
  return ORDER_TOOL_NAMES.has(name);
}

function requireAuth(client: WaitroseClient): void {
  if (!client.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated — this tool needs WAITROSE_USERNAME/WAITROSE_PASSWORD configured on the MCP server",
    );
  }
}

function parseLimit(args: Record<string, unknown>): number {
  const limit = args.limit;
  if (limit === undefined) return 10;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    throw new McpError(ErrorCode.InvalidParams, "limit must be a positive integer");
  }
  return Math.min(Math.floor(limit), 128);
}

function parseCustomerOrderId(args: Record<string, unknown>): string {
  const id = args.customerOrderId;
  if (typeof id !== "string" || !id) {
    throw new McpError(ErrorCode.InvalidParams, "customerOrderId is required");
  }
  return id;
}

export type OrderToolResponse =
  | Order[]
  | OrderDetails
  | { success: true; customerOrderId: string; action: string };

export async function dispatchOrderTool(
  client: WaitroseClient,
  toolName: OrderToolName,
  args: Record<string, unknown>,
): Promise<OrderToolResponse> {
  requireAuth(client);

  switch (toolName) {
    case "get_pending_orders":
      return client.getPendingOrders(parseLimit(args));

    case "get_previous_orders":
      return client.getPreviousOrders(parseLimit(args));

    case "get_order": {
      const customerOrderId = parseCustomerOrderId(args);
      return client.getOrder(customerOrderId);
    }

    case "cancel_order": {
      const customerOrderId = parseCustomerOrderId(args);
      await client.cancelOrder(customerOrderId);
      return { success: true, customerOrderId, action: "cancelled" };
    }

    case "initiate_amend_order": {
      const customerOrderId = parseCustomerOrderId(args);
      await client.initiateAmendOrder(customerOrderId);
      return { success: true, customerOrderId, action: "amend_initiated" };
    }

    case "cancel_amend_order": {
      const customerOrderId = parseCustomerOrderId(args);
      await client.cancelAmendOrder(customerOrderId);
      return { success: true, customerOrderId, action: "amend_cancelled" };
    }
  }
}
