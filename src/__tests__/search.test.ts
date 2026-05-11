import { describe, it, expect, vi, beforeEach } from "vitest";
import WaitroseClient from "../waitrose.js";

vi.mock("../metrics.js", () => ({
  reauthsTotal: { inc: vi.fn() },
  toolCallsTotal: { inc: vi.fn() },
  toolCallDuration: { startTimer: vi.fn(() => vi.fn()) },
  upstreamCallsTotal: { inc: vi.fn() },
  sessionAuthenticated: { set: vi.fn() },
  registry: { metrics: vi.fn(async () => ""), contentType: "text/plain" },
}));

vi.mock("../audit.js", () => ({
  redactArgs: vi.fn((_, args) => args),
  auditLog: vi.fn(),
}));

const SESSION_PAYLOAD = {
  data: {
    generateSession: {
      accessToken: "tok",
      refreshToken: "ref",
      customerId: "cust-1",
      customerOrderId: "order-1",
      customerOrderState: "ACTIVE",
      defaultBranchId: "651",
      expiresIn: 3600,
      failures: null,
    },
  },
};

const SEARCH_RESPONSE = {
  totalMatches: 0,
  componentsAndProducts: [],
};

describe("search — does not auto-inject defaultBranchId", () => {
  let client: WaitroseClient;
  let capturedBodies: any[] = [];

  beforeEach(() => {
    capturedBodies = [];
    client = new WaitroseClient();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (url.includes("graphql")) {
        return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
      }
      capturedBodies.push({ url, body });
      return { ok: true, json: async () => SEARCH_RESPONSE } as Response;
    }));
  });

  it("searchProducts omits branchId when none passed, even with session loaded", async () => {
    await client.login("u@example.com", "p");
    await client.searchProducts("chickpeas");
    expect(capturedBodies).toHaveLength(1);
    const qp = capturedBodies[0].body.customerSearchRequest.queryParams;
    expect(qp.branchId).toBeUndefined();
    expect(qp.searchTerm).toBe("chickpeas");
  });

  it("searchProducts forwards explicit branchId from caller", async () => {
    await client.login("u@example.com", "p");
    await client.searchProducts("chickpeas", { branchId: "327" });
    const qp = capturedBodies[0].body.customerSearchRequest.queryParams;
    expect(qp.branchId).toBe("327");
  });

  it("browseProducts omits branchId when none passed", async () => {
    await client.login("u@example.com", "p");
    await client.browseProducts("groceries/pantry");
    const qp = capturedBodies[0].body.customerSearchRequest.queryParams;
    expect(qp.branchId).toBeUndefined();
  });

  it("browseProducts forwards explicit branchId from caller", async () => {
    await client.login("u@example.com", "p");
    await client.browseProducts("groceries/pantry", { branchId: "327" });
    const qp = capturedBodies[0].body.customerSearchRequest.queryParams;
    expect(qp.branchId).toBe("327");
  });

  it("getPromotionProducts omits branchId when none passed", async () => {
    await client.login("u@example.com", "p");
    await client.getPromotionProducts("myWaitrose");
    const qp = capturedBodies[0].body.customerSearchRequest.queryParams;
    expect(qp.branchId).toBeUndefined();
  });

  it("getPromotionProducts forwards explicit branchId from caller", async () => {
    await client.login("u@example.com", "p");
    await client.getPromotionProducts("myWaitrose", { branchId: "327" });
    const qp = capturedBodies[0].body.customerSearchRequest.queryParams;
    expect(qp.branchId).toBe("327");
  });
});

describe("getProductsByLineNumbers — does not auto-inject defaultBranchId", () => {
  let client: WaitroseClient;
  let capturedUrls: string[] = [];

  beforeEach(() => {
    capturedUrls = [];
    client = new WaitroseClient();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn(async (url: string, _opts: RequestInit) => {
      if (url.includes("graphql")) {
        return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
      }
      capturedUrls.push(url);
      return { ok: true, json: async () => ({ products: [] }) } as Response;
    }));
  });

  it("omits branchId when no session is in scope", async () => {
    await client.getProductsByLineNumbers(["123", "456"]);
    expect(capturedUrls).toHaveLength(1);
    const params = new URL(capturedUrls[0]).searchParams;
    expect(params.has("branchId")).toBe(false);
  });

  it("omits branchId after login with session carrying defaultBranchId (regression for #26 fix)", async () => {
    await client.login("u@example.com", "p");
    await client.getProductsByLineNumbers(["123", "456"]);
    expect(capturedUrls).toHaveLength(1);
    const params = new URL(capturedUrls[0]).searchParams;
    expect(params.has("branchId")).toBe(false);
  });
});
