import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchOrderTool, isOrderTool } from "../order-tools.js";
import type WaitroseClient from "../waitrose.js";
import type { Order, OrderDetails } from "../waitrose.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

function makeClient(overrides: Partial<WaitroseClient> = {}): WaitroseClient {
  return {
    isAuthenticated: vi.fn().mockReturnValue(true),
    getPendingOrders: vi.fn(),
    getPreviousOrders: vi.fn(),
    getOrder: vi.fn(),
    cancelOrder: vi.fn(),
    initiateAmendOrder: vi.fn(),
    cancelAmendOrder: vi.fn(),
    ...overrides,
  } as unknown as WaitroseClient;
}

const stubOrder: Order = {
  customerOrderId: "ord-123",
  status: "PENDING",
  created: "2026-05-01T10:00:00Z",
  lastUpdated: "2026-05-01T10:01:00Z",
  slots: [],
  totals: {
    estimated: {
      totalPrice: { amount: 50, currencyCode: "GBP" },
      toPay: { amount: 50, currencyCode: "GBP" },
    },
    actual: { paid: null },
  },
};

const stubOrderDetails: OrderDetails = {
  customerOrderId: "ord-123",
  status: "PENDING",
  created: "2026-05-01T10:00:00Z",
  lastUpdated: "2026-05-01T10:01:00Z",
  orderLines: [],
  slots: [],
  containsEntertainingLines: false,
  substitutionsAllowed: true,
  bagless: false,
  totals: {
    estimated: {
      totalPrice: { amount: 50, currencyCode: "GBP" },
      toPay: { amount: 50, currencyCode: "GBP" },
      deliveryCharge: null,
      offerSavings: null,
      membershipSavings: null,
    },
    actual: {
      paid: null,
      savings: null,
      deliveryCharge: null,
    },
  },
};

describe("isOrderTool", () => {
  it("recognises order tool names", () => {
    expect(isOrderTool("get_pending_orders")).toBe(true);
    expect(isOrderTool("get_previous_orders")).toBe(true);
    expect(isOrderTool("get_order")).toBe(true);
    expect(isOrderTool("cancel_order")).toBe(true);
    expect(isOrderTool("initiate_amend_order")).toBe(true);
    expect(isOrderTool("cancel_amend_order")).toBe(true);
  });

  it("rejects non-order tool names", () => {
    expect(isOrderTool("search_products")).toBe(false);
    expect(isOrderTool("get_trolley")).toBe(false);
    expect(isOrderTool("unknown")).toBe(false);
  });
});

describe("dispatchOrderTool", () => {
  it("throws InvalidRequest when not authenticated", async () => {
    const client = makeClient({ isAuthenticated: vi.fn().mockReturnValue(false) });
    await expect(
      dispatchOrderTool(client, "get_pending_orders", {}),
      ).rejects.toThrow(McpError);
  });

  describe("get_pending_orders", () => {
    it("returns pending orders with default limit", async () => {
      const client = makeClient();
      vi.mocked(client.getPendingOrders).mockResolvedValue([stubOrder]);
      const result = await dispatchOrderTool(client, "get_pending_orders", {});
      expect(client.getPendingOrders).toHaveBeenCalledWith(10);
      expect(result).toEqual([stubOrder]);
    });

    it("passes custom limit", async () => {
      const client = makeClient();
      vi.mocked(client.getPendingOrders).mockResolvedValue([]);
      await dispatchOrderTool(client, "get_pending_orders", { limit: 5 });
      expect(client.getPendingOrders).toHaveBeenCalledWith(5);
    });

    it("caps limit at 128", async () => {
      const client = makeClient();
      vi.mocked(client.getPendingOrders).mockResolvedValue([]);
      await dispatchOrderTool(client, "get_pending_orders", { limit: 999 });
      expect(client.getPendingOrders).toHaveBeenCalledWith(128);
    });

    it("rejects invalid limit", async () => {
      const client = makeClient();
      await expect(
        dispatchOrderTool(client, "get_pending_orders", { limit: -1 }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("get_previous_orders", () => {
    it("returns previous orders with default limit", async () => {
      const client = makeClient();
      vi.mocked(client.getPreviousOrders).mockResolvedValue([stubOrder]);
      const result = await dispatchOrderTool(client, "get_previous_orders", {});
      expect(client.getPreviousOrders).toHaveBeenCalledWith(10);
      expect(result).toEqual([stubOrder]);
    });

    it("returns previous orders with custom limit", async () => {
      const client = makeClient();
      vi.mocked(client.getPreviousOrders).mockResolvedValue([stubOrder]);
      const result = await dispatchOrderTool(client, "get_previous_orders", { limit: 3 });
      expect(client.getPreviousOrders).toHaveBeenCalledWith(3);
      expect(result).toEqual([stubOrder]);
    });
  });

  describe("get_order", () => {
    it("fetches order detail by ID", async () => {
      const client = makeClient();
      vi.mocked(client.getOrder).mockResolvedValue(stubOrderDetails);
      const result = await dispatchOrderTool(client, "get_order", { customerOrderId: "ord-123" });
      expect(client.getOrder).toHaveBeenCalledWith("ord-123");
      expect(result).toEqual(stubOrderDetails);
    });

    it("throws InvalidParams when customerOrderId is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchOrderTool(client, "get_order", {}),
      ).rejects.toThrow(McpError);
    });
  });

  describe("cancel_order", () => {
    it("calls cancelOrder and returns success", async () => {
      const client = makeClient();
      vi.mocked(client.cancelOrder).mockResolvedValue(undefined);
      const result = await dispatchOrderTool(client, "cancel_order", { customerOrderId: "ord-456" });
      expect(client.cancelOrder).toHaveBeenCalledWith("ord-456");
      expect(result).toEqual({ success: true, customerOrderId: "ord-456", action: "cancelled" });
    });

    it("throws InvalidParams when customerOrderId is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchOrderTool(client, "cancel_order", {}),
      ).rejects.toThrow(McpError);
    });
  });

  describe("initiate_amend_order", () => {
    it("calls initiateAmendOrder and returns success", async () => {
      const client = makeClient();
      vi.mocked(client.initiateAmendOrder).mockResolvedValue(undefined);
      const result = await dispatchOrderTool(client, "initiate_amend_order", { customerOrderId: "ord-789" });
      expect(client.initiateAmendOrder).toHaveBeenCalledWith("ord-789");
      expect(result).toEqual({ success: true, customerOrderId: "ord-789", action: "amend_initiated" });
    });

    it("throws InvalidParams when customerOrderId is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchOrderTool(client, "initiate_amend_order", {}),
      ).rejects.toThrow(McpError);
    });
  });

  describe("cancel_amend_order", () => {
    it("calls cancelAmendOrder and returns success", async () => {
      const client = makeClient(),
      vi.mocked(client.cancelAmendOrder).mockResolvedValue(undefined);
      const result = await dispatchOrderTool(client, "cancel_amend_order", { customerOrderId: "ord-789" });
      expect(client.cancelAmendOrder).toHaveBeenCalledWith("ord-789");
      expect(result).toEqual({ success: true, customerOrderId: "ord-789", action: "amend_cancelled" });
    });

    it("throws InvalidParams when customerOrderId is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchOrderTool(client, "cancel_amend_order", {}),
      ).rejects.toThrow(McpError);
    });
  });
});
