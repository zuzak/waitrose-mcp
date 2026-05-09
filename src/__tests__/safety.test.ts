import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkBasketItemCap, checkBasketValueCap, checkQtyPerLineCap, CapError } from "../safety.js";
import type { TrolleyResponse } from "../waitrose.js";

function makeTrolley(itemCount: number, totalGbp: number): TrolleyResponse {
  return {
    products: [],
    trolley: {
      orderId: "order-1",
      trolleyItems: Array.from({ length: itemCount }, (_, i) => ({
        lineNumber: `ln${i}`,
        trolleyItemId: i,
        quantity: { amount: 1, uom: "C62" },
        totalPrice: { amount: 1, currencyCode: "GBP" },
        canSubstitute: true,
        noteToShopper: null,
      })),
      trolleyTotals: {
        totalEstimatedCost: { amount: totalGbp, currencyCode: "GBP" },
        itemTotalEstimatedCost: { amount: totalGbp, currencyCode: "GBP" },
        deliveryCharge: null,
        savingsFromOffers: null,
        savingsFromMyWaitrose: null,
      },
      conflicts: [],
    },
    failures: null,
  };
}

describe("checkBasketItemCap", () => {
  it("allows when below cap", () => {
    expect(() => checkBasketItemCap(makeTrolley(49, 0), 50)).not.toThrow();
  });

  it("denies at cap boundary", () => {
    expect(() => checkBasketItemCap(makeTrolley(50, 0), 50)).toThrow(CapError);
  });

  it("error message mentions env var", () => {
    expect(() => checkBasketItemCap(makeTrolley(50, 0), 50)).toThrow(
      "WAITROSE_MAX_BASKET_ITEMS",
    );
  });
});

describe("checkBasketValueCap", () => {
  it("allows when below cap", () => {
    expect(() => checkBasketValueCap(makeTrolley(0, 199.99), 200)).not.toThrow();
  });

  it("denies at cap boundary", () => {
    expect(() => checkBasketValueCap(makeTrolley(0, 200), 200)).toThrow(CapError);
  });

  it("error message mentions env var", () => {
    expect(() => checkBasketValueCap(makeTrolley(0, 200), 200)).toThrow(
      "WAITROSE_MAX_BASKET_VALUE_GBP",
    );
  });
});

describe("checkQtyPerLineCap", () => {
  it("allows quantity below cap", () => {
    expect(() =>
      checkQtyPerLineCap([{ lineNumber: "ln1", quantity: { amount: 4, uom: "C62" } }], 5),
    ).not.toThrow();
  });

  it("denies at cap boundary", () => {
    expect(() =>
      checkQtyPerLineCap([{ lineNumber: "ln1", quantity: { amount: 5, uom: "C62" } }], 5),
    ).toThrow(CapError);
  });

  it("error message mentions env var and line number", () => {
    expect(() =>
      checkQtyPerLineCap([{ lineNumber: "X", quantity: { amount: 5, uom: "C62" } }], 5),
    ).toThrow("WAITROSE_MAX_QTY_PER_LINE");
  });

  it("checks all items — denies if any line exceeds cap", () => {
    expect(() =>
      checkQtyPerLineCap(
        [
          { lineNumber: "ok", quantity: { amount: 1, uom: "C62" } },
          { lineNumber: "bad", quantity: { amount: 5, uom: "C62" } },
        ],
        5,
      ),
    ).toThrow(CapError);
  });
});

describe("env var NaN fallback", () => {
  const ENV_KEYS = [
    "WAITROSE_MAX_BASKET_ITEMS",
    "WAITROSE_MAX_BASKET_VALUE_GBP",
    "WAITROSE_MAX_QTY_PER_LINE",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("checkBasketItemCap falls back to 50 when env var is non-numeric", () => {
    process.env.WAITROSE_MAX_BASKET_ITEMS = "abc";
    expect(() => checkBasketItemCap(makeTrolley(49, 0))).not.toThrow();
    expect(() => checkBasketItemCap(makeTrolley(50, 0))).toThrow(CapError);
  });

  it("checkBasketValueCap falls back to 200 when env var is non-numeric", () => {
    process.env.WAITROSE_MAX_BASKET_VALUE_GBP = "not-a-number";
    expect(() => checkBasketValueCap(makeTrolley(0, 199.99))).not.toThrow();
    expect(() => checkBasketValueCap(makeTrolley(0, 200))).toThrow(CapError);
  });

  it("checkQtyPerLineCap falls back to 5 when env var is non-numeric", () => {
    process.env.WAITROSE_MAX_QTY_PER_LINE = "xyz";
    expect(() =>
      checkQtyPerLineCap([{ lineNumber: "ln1", quantity: { amount: 4, uom: "C62" } }]),
    ).not.toThrow();
    expect(() =>
      checkQtyPerLineCap([{ lineNumber: "ln1", quantity: { amount: 5, uom: "C62" } }]),
    ).toThrow(CapError);
  });
});

describe("rate-limiter queue overflow", () => {
  it("DeniedError thrown when queue full", async () => {
    const { TokenBucket, DeniedError } = await import("../rate-limiter.js");
    // burst 0, queue depth 0 → immediate denial regardless of rate
    const bucket = new TokenBucket(1, 0, 0);
    await expect(bucket.acquire()).rejects.toBeInstanceOf(DeniedError);
  });
});
