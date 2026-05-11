import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchSlotTool, isSlotTool } from "../slot-tools.js";
import type WaitroseClient from "../waitrose.js";
import type { CurrentSlot, SlotDate, SlotDay, BookSlotResult } from "../waitrose.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

function makeClient(overrides: Partial<WaitroseClient> = {}): WaitroseClient {
  return {
    isAuthenticated: vi.fn().mockReturnValue(true),
    getCurrentSlot: vi.fn(),
    getSlotDates: vi.fn(),
    getSlotDays: vi.fn(),
    bookSlot: vi.fn(),
    ...overrides,
  } as unknown as WaitroseClient;
}

const stubSlot: CurrentSlot = {
  slotType: "DELIVERY",
  branchId: "968",
  addressId: "addr-1",
  postcode: null,
  startDateTime: "2026-05-14T10:00:00Z",
  endDateTime: "2026-05-14T12:00:00Z",
  expiryDateTime: "2026-05-14T09:00:00Z",
  orderCutoffDateTime: "2026-05-13T20:00:00Z",
  amendOrderCutoffDateTime: "2026-05-13T20:00:00Z",
  shopByDateTime: "2026-05-13T20:00:00Z",
  deliveryCharge: { amount: 0, currencyCode: "GBP" },
  slotGridType: "NORMAL",
};

const stubSlotDate: SlotDate = {
  id: "2026-05-14",
  dayOfWeek: "WEDNESDAY",
};

const stubSlotDay: SlotDay = {
  id: "day-1",
  branchId: "968",
  slotType: "DELIVERY",
  date: "2026-05-14",
  slots: [
    {
      id: "slot-abc",
      startDateTime: "2026-05-14T10:00:00Z",
      endDateTime: "2026-05-14T12:00:00Z",
      shopByDateTime: "2026-05-13T20:00:00Z",
      status: "AVAILABLE",
      charge: { amount: 0, currencyCode: "GBP" },
      greenSlot: true,
      deliveryPassSlot: false,
    },
  ],
};

const stubBookResult: BookSlotResult = {
  slotExpiryDateTime: "2026-05-14T09:00:00Z",
  orderCutoffDateTime: "2026-05-13T20:00:00Z",
  amendOrderCutoffDateTime: "2026-05-13T20:00:00Z",
  shopByDateTime: "2026-05-13T20:00:00Z",
};

describe("isSlotTool", () => {
  it("recognises slot tool names", () => {
    expect(isSlotTool("get_current_slot")).toBe(true);
    expect(isSlotTool("list_slot_dates")).toBe(true);
    expect(isSlotTool("list_slot_days")).toBe(true);
    expect(isSlotTool("book_slot")).toBe(true);
  });

  it("rejects non-slot tool names", () => {
    expect(isSlotTool("search_products")).toBe(false);
    expect(isSlotTool("get_trolley")).toBe(false);
    expect(isSlotTool("unknown")).toBe(false);
  });
});

describe("dispatchSlotTool", () => {
  it("throws InvalidRequest when not authenticated", async () => {
    const client = makeClient({ isAuthenticated: vi.fn().mockReturnValue(false) });
    await expect(
      dispatchSlotTool(client, "get_current_slot", {}),
    ).rejects.toThrow(McpError);
  });

  describe("get_current_slot", () => {
    it("returns current slot", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(stubSlot);
      const result = await dispatchSlotTool(client, "get_current_slot", {});
      expect(client.getCurrentSlot).toHaveBeenCalledWith(undefined);
      expect(result).toEqual(stubSlot);
    });

    it("returns null when no slot is booked", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(null);
      const result = await dispatchSlotTool(client, "get_current_slot", {});
      expect(result).toBeNull();
    });

    it("passes postcode through when provided", async () => {
      const client = makeClient();
      vi.mocked(client.getCurrentSlot).mockResolvedValue(stubSlot);
      await dispatchSlotTool(client, "get_current_slot", { postcode: "SW1A 1AA" });
      expect(client.getCurrentSlot).toHaveBeenCalledWith("SW1A 1AA");
    });

    it("throws InvalidParams when postcode is not a string", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "get_current_slot", { postcode: 12345 }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("list_slot_dates", () => {
    it("returns available dates for DELIVERY", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDates).mockResolvedValue([stubSlotDate]);
      const result = await dispatchSlotTool(client, "list_slot_dates", {
        slotType: "DELIVERY",
      });
      expect(client.getSlotDates).toHaveBeenCalledWith("DELIVERY", undefined, undefined);
      expect(result).toEqual([stubSlotDate]);
    });

    it("passes branchId and addressId when provided", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDates).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slot_dates", {
        slotType: "COLLECTION",
        branchId: "968",
        addressId: "addr-1",
      });
      expect(client.getSlotDates).toHaveBeenCalledWith("COLLECTION", "968", "addr-1");
    });

    it("throws InvalidParams when slotType is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_dates", {}),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is invalid", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_dates", { slotType: "BICYCLE" }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("list_slot_days", () => {
    it("returns slot days for a given date", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue([stubSlotDay]);
      const result = await dispatchSlotTool(client, "list_slot_days", {
        slotType: "DELIVERY",
        fromDate: "2026-05-14",
      });
      expect(client.getSlotDays).toHaveBeenCalledWith(
        "DELIVERY",
        "2026-05-14",
        undefined,
        undefined,
      );
      expect(result).toEqual([stubSlotDay]);
    });

    it("passes optional params when provided", async () => {
      const client = makeClient();
      vi.mocked(client.getSlotDays).mockResolvedValue([]);
      await dispatchSlotTool(client, "list_slot_days", {
        slotType: "COLLECTION",
        fromDate: "2026-05-15",
        branchId: "968",
        addressId: "addr-2",
      });
      expect(client.getSlotDays).toHaveBeenCalledWith(
        "COLLECTION",
        "2026-05-15",
        "968",
        "addr-2",
      );
    });

    it("throws InvalidParams when fromDate is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_days", { slotType: "DELIVERY" }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is invalid", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "list_slot_days", {
          slotType: "WALK",
          fromDate: "2026-05-14",
        }),
      ).rejects.toThrow(McpError);
    });
  });

  describe("book_slot", () => {
    it("books a slot and returns result when confirm is true", async () => {
      const client = makeClient();
      vi.mocked(client.bookSlot).mockResolvedValue(stubBookResult);
      const result = await dispatchSlotTool(client, "book_slot", {
        slotId: "slot-abc",
        slotType: "DELIVERY",
        confirm: true,
      });
      expect(client.bookSlot).toHaveBeenCalledWith("slot-abc", "DELIVERY", undefined);
      expect(result).toEqual(stubBookResult);
    });

    it("passes addressId when provided", async () => {
      const client = makeClient();
      vi.mocked(client.bookSlot).mockResolvedValue(stubBookResult);
      await dispatchSlotTool(client, "book_slot", {
        slotId: "slot-abc",
        slotType: "DELIVERY",
        addressId: "addr-1",
        confirm: true,
      });
      expect(client.bookSlot).toHaveBeenCalledWith("slot-abc", "DELIVERY", "addr-1");
    });

    it("throws InvalidParams when confirm is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "slot-abc",
          slotType: "DELIVERY",
        }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when confirm is false", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "slot-abc",
          slotType: "DELIVERY",
          confirm: false,
        }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotId is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", { slotType: "DELIVERY", confirm: true }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is missing", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", { slotId: "slot-abc", confirm: true }),
      ).rejects.toThrow(McpError);
    });

    it("throws InvalidParams when slotType is invalid", async () => {
      const client = makeClient();
      await expect(
        dispatchSlotTool(client, "book_slot", {
          slotId: "slot-abc",
          slotType: "TELEPORT",
          confirm: true,
        }),
      ).rejects.toThrow(McpError);
    });
  });
});
