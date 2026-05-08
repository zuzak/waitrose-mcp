import type { TrolleyResponse, TrolleyItemInput } from "./waitrose.js";

export class CapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapError";
  }
}

/**
 * Throw CapError if the trolley already has maxItems or more distinct line items.
 * Called before adding a new item.
 */
export function checkBasketItemCap(
  trolley: TrolleyResponse,
  maxItems: number = parseInt(process.env.WAITROSE_MAX_BASKET_ITEMS ?? "50", 10),
): void {
  const count = trolley.trolley.trolleyItems.length;
  if (count >= maxItems) {
    throw new CapError(
      `Basket already has ${count} items (cap: ${maxItems}). ` +
        `Increase WAITROSE_MAX_BASKET_ITEMS to override.`,
    );
  }
}

/**
 * Throw CapError if the current trolley estimated total meets or exceeds maxGbp.
 */
export function checkBasketValueCap(
  trolley: TrolleyResponse,
  maxGbp: number = parseFloat(process.env.WAITROSE_MAX_BASKET_VALUE_GBP ?? "200"),
): void {
  const total = trolley.trolley.trolleyTotals.totalEstimatedCost?.amount ?? 0;
  if (total >= maxGbp) {
    throw new CapError(
      `Basket estimated total £${total.toFixed(2)} meets or exceeds cap £${maxGbp.toFixed(2)}. ` +
        `Increase WAITROSE_MAX_BASKET_VALUE_GBP to override.`,
    );
  }
}

/**
 * Throw CapError if any item in the proposed update would set quantity >= maxQty.
 * This doubles as the anomaly check: the same threshold guards against
 * "stock up" misinterpretation.
 */
export function checkQtyPerLineCap(
  items: TrolleyItemInput[],
  maxQty: number = parseInt(process.env.WAITROSE_MAX_QTY_PER_LINE ?? "5", 10),
): void {
  for (const item of items) {
    if (item.quantity.amount >= maxQty) {
      throw new CapError(
        `Quantity ${item.quantity.amount} for line ${item.lineNumber} meets or exceeds cap ${maxQty}. ` +
          `Increase WAITROSE_MAX_QTY_PER_LINE to override.`,
      );
    }
  }
}
