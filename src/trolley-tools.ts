import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "./waitrose.js";
import type {
  ApiFailure,
  Price,
  TrolleyItemInput,
  TrolleyResponse,
  UnitOfMeasure,
} from "./waitrose.js";
import {
  checkBasketItemCap,
  checkBasketValueCap,
  checkQtyPerLineCap,
} from "./safety.js";

/**
 * A short summary surfaced at the top of every trolley tool response so
 * Claude can see the prominent state — whether the £40 minimum is met,
 * the running total, the item count, and any upstream failures — without
 * digging through the raw response body. The original response is spread
 * after this summary, so consumers that want full detail still have it.
 */
export interface TrolleySummary {
  itemCount: number;
  totalEstimatedCost: Price;
  minimumSpendThresholdMet: boolean | null;
  failures: ApiFailure[];
}

export type TrolleyToolResponse = TrolleyResponse & { summary: TrolleySummary };

function summarise(r: TrolleyResponse): TrolleyToolResponse {
  const summary: TrolleySummary = {
    itemCount: r.trolley.trolleyItems.length,
    totalEstimatedCost: r.trolley.trolleyTotals.totalEstimatedCost,
    minimumSpendThresholdMet: r.trolley.trolleyTotals.minimumSpendThresholdMet ?? null,
    failures: r.failures ?? [],
  };
  return { summary, ...r };
}

export type TrolleyToolName =
  | "get_trolley"
  | "add_to_trolley"
  | "remove_from_trolley"
  | "update_trolley_items"
  | "empty_trolley";

const TROLLEY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_trolley",
  "add_to_trolley",
  "remove_from_trolley",
  "update_trolley_items",
  "empty_trolley",
]);

export function isTrolleyTool(name: string): name is TrolleyToolName {
  return TROLLEY_TOOL_NAMES.has(name);
}

function requireAuth(client: WaitroseClient): void {
  if (!client.isAuthenticated()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Not authenticated — this tool needs WAITROSE_USERNAME/WAITROSE_PASSWORD configured on the MCP server",
    );
  }
}

function parseAddToTrolley(args: Record<string, unknown>): {
  lineNumber: string;
  quantity: number;
  uom: UnitOfMeasure;
} {
  const lineNumber = args.lineNumber;
  const quantity = (args.quantity as number | undefined) ?? 1;
  const uom = (args.uom as UnitOfMeasure | undefined) ?? "C62";
  if (typeof lineNumber !== "string" || !lineNumber) {
    throw new McpError(ErrorCode.InvalidParams, "lineNumber is required");
  }
  if (typeof quantity !== "number" || quantity <= 0 || !Number.isFinite(quantity)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "quantity must be a positive number",
    );
  }
  return { lineNumber, quantity, uom };
}

function parseUpdateItems(args: Record<string, unknown>): TrolleyItemInput[] {
  const rawItems = args.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "items must be a non-empty array",
    );
  }
  return rawItems.map((raw, idx) => {
    if (!raw || typeof raw !== "object") {
      throw new McpError(
        ErrorCode.InvalidParams,
        `items[${idx}] must be an object`,
      );
    }
    const obj = raw as Record<string, unknown>;
    const ln = obj.lineNumber;
    const qty = obj.quantity;
    const uom = (obj.uom as UnitOfMeasure | undefined) ?? "C62";
    if (typeof ln !== "string" || !ln) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `items[${idx}].lineNumber is required`,
      );
    }
    if (typeof qty !== "number" || qty < 0 || !Number.isFinite(qty)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `items[${idx}].quantity must be a non-negative number`,
      );
    }
    const item: TrolleyItemInput = {
      lineNumber: ln,
      quantity: { amount: qty, uom },
    };
    if (typeof obj.noteToShopper === "string") item.noteToShopper = obj.noteToShopper;
    if (typeof obj.canSubstitute === "boolean") item.canSubstitute = obj.canSubstitute;
    return item;
  });
}

/**
 * Dispatch a trolley tool call. Caller is responsible for wrapping the
 * returned data into the MCP `{content: [...]}` shape and for catching
 * CapError / DeniedError to map them to a "denied" outcome.
 */
export async function dispatchTrolleyTool(
  client: WaitroseClient,
  toolName: TrolleyToolName,
  args: Record<string, unknown>,
): Promise<TrolleyToolResponse> {
  requireAuth(client);

  switch (toolName) {
    case "get_trolley":
      return summarise(await client.getTrolley());

    case "add_to_trolley": {
      const { lineNumber, quantity, uom } = parseAddToTrolley(args);
      checkQtyPerLineCap([{ lineNumber, quantity: { amount: quantity, uom } }]);
      const trolley = await client.getTrolley();
      checkBasketValueCap(trolley);
      const isNewLine = !trolley.trolley.trolleyItems.some(
        (i) => i.lineNumber === lineNumber,
      );
      if (isNewLine) checkBasketItemCap(trolley);
      return summarise(await client.addToTrolley(lineNumber, quantity, uom));
    }

    case "remove_from_trolley": {
      const lineNumber = args.lineNumber;
      if (typeof lineNumber !== "string" || !lineNumber) {
        throw new McpError(ErrorCode.InvalidParams, "lineNumber is required");
      }
      return summarise(await client.removeFromTrolley(lineNumber));
    }

    case "update_trolley_items": {
      const items = parseUpdateItems(args);
      checkQtyPerLineCap(items);
      const trolley = await client.getTrolley();
      checkBasketValueCap(trolley);
      const currentLines = new Set(
        trolley.trolley.trolleyItems.map((i) => i.lineNumber),
      );
      const addsNewLine = items.some(
        (i) => !currentLines.has(i.lineNumber) && i.quantity.amount > 0,
      );
      if (addsNewLine) checkBasketItemCap(trolley);
      return summarise(await client.updateTrolleyItems(items));
    }

    case "empty_trolley":
      return summarise(await client.emptyTrolley());
  }
}
