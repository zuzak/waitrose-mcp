import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "./waitrose.js";
import type { CurrentSlot, SlotDate, SlotDay, BookSlotResult, SlotType } from "./waitrose.js";

export type SlotToolName =
  | "get_current_slot"
  | "list_slot_dates"
  | "list_slot_days"
  | "book_slot";

const SLOT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_current_slot",
  "list_slot_dates",
  "list_slot_days",
  "book_slot",
]);

export function isSlotTool(name: string): name is SlotToolName {
  return SLOT_TOOL_NAMES.has(name);
}

function requireAuth(client: WaitroseClient): void {
  if (!client.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated — this tool needs WAITROSE_USERNAME/WAITROSE_PASSWORD configured on the MCP server",
    );
  }
}

function parseSlotType(args: Record<string, unknown>): SlotType {
  const slotType = args.slotType;
  if (slotType !== "DELIVERY" && slotType !== "COLLECTION") {
    throw new McpError(
      ErrorCode.InvalidParams,
      "slotType must be DELIVERY or COLLECTION",
    );
  }
  return slotType;
}

function parseOptionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string") {
    throw new McpError(ErrorCode.InvalidParams, `${key} must be a string`);
  }
  return val;
}

export type SlotToolResponse =
  | CurrentSlot
  | null
  | SlotDate[]
  | SlotDay[]
  | BookSlotResult;

export async function dispatchSlotTool(
  client: WaitroseClient,
  toolName: SlotToolName,
  args: Record<string, unknown>,
): Promise<SlotToolResponse> {
  requireAuth(client);

  switch (toolName) {
    case "get_current_slot": {
      const postcode = parseOptionalString(args, "postcode");
      return client.getCurrentSlot(postcode);
    }

    case "list_slot_dates": {
      const slotType = parseSlotType(args);
      const branchId = parseOptionalString(args, "branchId");
      const addressId = parseOptionalString(args, "addressId");
      return client.getSlotDates(slotType, branchId, addressId);
    }

    case "list_slot_days": {
      const slotType = parseSlotType(args);
      const fromDate = args.fromDate;
      if (typeof fromDate !== "string" || !fromDate) {
        throw new McpError(ErrorCode.InvalidParams, "fromDate is required");
      }
      const branchId = parseOptionalString(args, "branchId");
      const addressId = parseOptionalString(args, "addressId");
      return client.getSlotDays(slotType, fromDate, branchId, addressId);
    }

    case "book_slot": {
      const slotId = args.slotId;
      if (typeof slotId !== "string" || !slotId) {
        throw new McpError(ErrorCode.InvalidParams, "slotId is required");
      }
      const slotType = parseSlotType(args);
      const addressId = parseOptionalString(args, "addressId");
      return client.bookSlot(slotId, slotType, addressId);
    }
  }
}
