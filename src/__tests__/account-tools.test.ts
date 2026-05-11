import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type WaitroseClient from "../waitrose.js";
import type { ShoppingContext, AccountProfile, Membership, Campaign } from "../waitrose.js";
import { dispatchAccountTool, isAccountTool } from "../account-tools.js";
import { redactArgs } from "../audit.js";

const SHOPPING_CONTEXT: ShoppingContext = {
  customerId: "cust-1",
  customerOrderId: "order-1",
  customerOrderState: "ACTIVE",
  defaultBranchId: "branch-1",
};

const ACCOUNT_PROFILE: AccountProfile = {
  id: "prof-1",
  email: "user@example.com",
  contactAddress: {
    id: "addr-1",
    line1: "123 Test St",
    line2: "",
    line3: "",
    town: "Glasgow",
    postalCode: "G1 1AA",
  },
};

const CAMPAIGNS: Campaign[] = [
  {
    id: "camp-1",
    name: "Summer Savings",
    marketingStartDate: "2025-06-01",
    marketingEndDate: "2025-08-31",
    startDate: "2025-06-01",
    endDate: "2025-08-31",
  },
];

interface MockClient {
  isAuthenticated: ReturnType<typeof vi.fn>;
  getShoppingContext: ReturnType<typeof vi.fn>;
  getAccountInfo: ReturnType<typeof vi.fn>;
  getCampaigns: ReturnType<typeof vi.fn>;
}

function makeClient(authenticated = true): MockClient {
  return {
    isAuthenticated: vi.fn(() => authenticated),
    getShoppingContext: vi.fn(async () => SHOPPING_CONTEXT),
    getAccountInfo: vi.fn(async () => ({
      profile: ACCOUNT_PROFILE,
      memberships: [{ number: "1234567890", type: "myWaitrose" }] as Membership[],
    })),
    getCampaigns: vi.fn(async () => CAMPAIGNS),
  };
}

const asClient = (c: MockClient): WaitroseClient => c as unknown as WaitroseClient;

describe("isAccountTool", () => {
  it("recognises the three account tools", () => {
    for (const name of ["get_shopping_context", "get_account_info", "get_campaigns"]) {
      expect(isAccountTool(name)).toBe(true);
    }
  });

  it("rejects other tool names", () => {
    expect(isAccountTool("search_products")).toBe(false);
    expect(isAccountTool("get_trolley")).toBe(false);
    expect(isAccountTool("checkout")).toBe(false);
  });
});

describe("dispatchAccountTool — auth gate", () => {
  it("throws McpError when client is not authenticated", async () => {
    const client = makeClient(false);
    await expect(
      dispatchAccountTool(asClient(client), "get_shopping_context", {}),
    ).rejects.toBeInstanceOf(McpError);
    expect(client.getShoppingContext).not.toHaveBeenCalled();
  });
});

describe("dispatchAccountTool — get_shopping_context", () => {
  it("returns the shopping context from the client", async () => {
    const client = makeClient();
    const data = await dispatchAccountTool(asClient(client), "get_shopping_context", {});
    expect(data).toEqual(SHOPPING_CONTEXT);
    expect(client.getShoppingContext).toHaveBeenCalledOnce();
  });
});

describe("dispatchAccountTool — get_account_info", () => {
  it("returns profile and memberships", async () => {
    const client = makeClient();
    const data = await dispatchAccountTool(asClient(client), "get_account_info", {}) as {
      profile: AccountProfile;
      memberships: Membership[] | null;
    };
    expect(data.profile.id).toBe("prof-1");
    expect(data.memberships).toHaveLength(1);
    expect(client.getAccountInfo).toHaveBeenCalledOnce();
  });

  it("handles null memberships", async () => {
    const client = makeClient();
    client.getAccountInfo.mockResolvedValueOnce({ profile: ACCOUNT_PROFILE, memberships: null });
    const data = await dispatchAccountTool(asClient(client), "get_account_info", {}) as {
      profile: AccountProfile;
      memberships: Membership[] | null;
    };
    expect(data.memberships).toBeNull();
  });

  it("audit SAFE_ARGS for get_account_info is empty — no PII logged", () => {
    const redacted = redactArgs("get_account_info", { anything: "sensitive" });
    expect(redacted).toEqual({ anything: "<redacted>" });
  });
});

describe("dispatchAccountTool — get_campaigns", () => {
  it("returns the campaigns array", async () => {
    const client = makeClient();
    const data = await dispatchAccountTool(asClient(client), "get_campaigns", {}) as Campaign[];
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("camp-1");
    expect(client.getCampaigns).toHaveBeenCalledOnce();
  });

  it("returns empty array when no campaigns", async () => {
    const client = makeClient();
    client.getCampaigns.mockResolvedValueOnce([]);
    const data = await dispatchAccountTool(asClient(client), "get_campaigns", {}) as Campaign[];
    expect(data).toHaveLength(0);
  });
});
