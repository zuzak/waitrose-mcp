import { describe, it, expect, vi, beforeEach } from "vitest";
import WaitroseClient from "../waitrose.js";

// Stub metrics and audit modules so tests don't need a real registry
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
      accessToken: "tok-fresh",
      refreshToken: "ref",
      customerId: "cust-1",
      customerOrderId: "order-1",
      customerOrderState: "ACTIVE",
      defaultBranchId: "branch-1",
      expiresIn: 3600,
      failures: null,
    },
  },
};

function makeSearchResponse() {
  return { totalMatches: 1, componentsAndProducts: [{ searchProduct: { id: "p1", lineNumber: "ln1", name: "Feta", displayPrice: "£2.00" } }] };
}

describe("auth resilience — graphql", () => {
  let client: WaitroseClient;

  beforeEach(() => {
    client = new WaitroseClient();
    vi.restoreAllMocks();
  });

  it("retries once after 401 and succeeds", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      callCount++;
      if (url.includes("graphql")) {
        // First call is login (succeeds), second is the real call (401), third is re-login (succeeds), fourth is retry (succeeds)
        if (callCount === 1) return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
        if (callCount === 2) return { ok: false, status: 401, text: async () => "Unauthorized" } as unknown as Response;
        if (callCount === 3) return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
        return { ok: true, json: async () => ({ data: { shoppingContext: { customerId: "c" } } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }));

    await client.login("user@example.com", "pass");
    const ctx = await client.getShoppingContext();
    expect(ctx).toBeDefined();
    expect(callCount).toBe(4);
  });

  it("sends Bearer unauthenticated on reauth, not the expired token", async () => {
    const newSessionAuthHeaders: string[] = [];
    let shoppingContextCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      const auth = (opts?.headers as Record<string, string>)?.["Authorization"];
      if (url.includes("graphql")) {
        if (body.query?.includes("NewSession")) {
          newSessionAuthHeaders.push(auth);
          return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
        }
        // shoppingContext: first call 401s to trigger reauth, retry succeeds
        shoppingContextCalls++;
        if (shoppingContextCalls === 1) {
          return { ok: false, status: 401, text: async () => "Unauthorized" } as unknown as Response;
        }
        return { ok: true, json: async () => ({ data: { shoppingContext: { customerId: "c" } } }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }));

    await client.login("user@example.com", "pass");
    await client.getShoppingContext();

    expect(newSessionAuthHeaders).toHaveLength(2);
    expect(newSessionAuthHeaders[0]).toBe("Bearer unauthenticated");
    expect(newSessionAuthHeaders[1]).toBe("Bearer unauthenticated");
  });

  it("does not loop — re-authenticates at most once on persistent 401", async () => {
    let loginCalls = 0;
    let shoppingContextCalls = 0;

    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if (url.includes("graphql")) {
        if (body.query?.includes("NewSession")) {
          loginCalls++;
          return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
        }
        shoppingContextCalls++;
        // Always 401 for non-login calls
        return { ok: false, status: 401, text: async () => "Unauthorized" } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }));

    await client.login("user@example.com", "pass");
    await expect(client.getShoppingContext()).rejects.toThrow("401");

    // Initial login + 1 re-auth = 2 login calls; shoppingContext called twice (initial + retry)
    expect(loginCalls).toBe(2);
    expect(shoppingContextCalls).toBe(2);
  });
});

describe("auth resilience — getProductsByLineNumbers", () => {
  let client: WaitroseClient;

  beforeEach(() => {
    client = new WaitroseClient();
    vi.restoreAllMocks();
  });

  it("retries once after 401 on getProductsByLineNumbers", async () => {
    let productsCallCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if ((url as string).includes("graphql")) {
        return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
      }
      if ((url as string).includes("products-prod")) {
        productsCallCount++;
        if (productsCallCount === 1) return { ok: false, status: 401, text: async () => "Unauthorized" } as unknown as Response;
        return { ok: true, json: async () => ({ products: [{ id: "p1", lineNumber: "ln1", name: "Feta" }] }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }));

    await client.login("user@example.com", "pass");
    const products = await client.getProductsByLineNumbers(["ln1"]);
    expect(products).toHaveLength(1);
    expect(productsCallCount).toBe(2);
  });
});

describe("auth resilience — restApi (read tools)", () => {
  let client: WaitroseClient;

  beforeEach(() => {
    client = new WaitroseClient();
    vi.restoreAllMocks();
  });

  it("passes authenticated customerId when logged in", async () => {
    const capturedUrls: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      capturedUrls.push(url as string);
      const body = opts?.body ? JSON.parse(opts.body as string) : {};
      if ((url as string).includes("graphql")) {
        return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
      }
      return { ok: true, json: async () => makeSearchResponse() } as Response;
    }));

    await client.login("user@example.com", "pass");
    await client.searchProducts("feta");

    const searchUrl = capturedUrls.find(u => u.includes("productcontent"));
    expect(searchUrl).toContain("cust-1");
    expect(searchUrl).not.toContain("/-1");
  });

  it("retries rest API once after 401", async () => {
    let restCallCount = 0;

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if ((url as string).includes("graphql")) {
        return { ok: true, json: async () => SESSION_PAYLOAD } as Response;
      }
      restCallCount++;
      if (restCallCount === 1) return { ok: false, status: 401, text: async () => "Unauthorized" } as unknown as Response;
      return { ok: true, json: async () => makeSearchResponse() } as Response;
    }));

    await client.login("user@example.com", "pass");
    const results = await client.searchProducts("feta");
    expect(results.totalMatches).toBe(1);
    expect(restCallCount).toBe(2);
  });
});
