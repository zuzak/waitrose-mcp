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

const BROWSE_API = "https://www.waitrose.com/api/content-prod/v2/cms/publish/productcontent/browse/-1?clientType=WEB_APP";

function browseApiResponse(subCategories: unknown[]): Response {
  return {
    ok: true,
    status: 200,
    text: async () => "",
    json: async () => ({ totalMatches: 10, productsInResultset: 1, subCategories, componentsAndProducts: [] }),
  } as unknown as Response;
}

describe("getCategoryNavigation", () => {
  let client: WaitroseClient;

  beforeEach(() => {
    client = new WaitroseClient();
    vi.restoreAllMocks();
  });

  it("calls the browse API with the default root categoryId and returns mapped entries", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(BROWSE_API);
      return browseApiResponse([
        { name: "Fresh & Chilled", categoryId: "301134", expectedResults: 3527, hiddenInNav: false },
        { name: "Bakery", categoryId: "300119", expectedResults: 553, hiddenInNav: false },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getCategoryNavigation();

    expect(result).toEqual([
      { name: "Fresh & Chilled", categoryId: "301134", productCount: 3527 },
      { name: "Bakery", categoryId: "300119", productCount: 553 },
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.customerSearchRequest.queryParams.category).toBe("10051");
  });

  it("passes a provided categoryId to the browse API", async () => {
    const fetchMock = vi.fn(async () => browseApiResponse([
      { name: "Bread", categoryId: "300121", expectedResults: 105, hiddenInNav: false },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getCategoryNavigation("300119");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Bread", categoryId: "300121", productCount: 105 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.customerSearchRequest.queryParams.category).toBe("300119");
  });

  it("filters out hiddenInNav entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => browseApiResponse([
      { name: "Bakery", categoryId: "300119", expectedResults: 553, hiddenInNav: false },
      { name: "Hidden", categoryId: "999", expectedResults: 1, hiddenInNav: true },
    ])));

    const result = await client.getCategoryNavigation();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Bakery");
  });

  it("returns an empty array when subCategories is absent or empty", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ totalMatches: 0, subCategories: [], componentsAndProducts: [] }),
    } as unknown as Response)));

    expect(await client.getCategoryNavigation()).toEqual([]);
  });

  it("throws on non-2xx HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 404, text: async () => "not found",
    } as unknown as Response)));
    await expect(client.getCategoryNavigation("300119")).rejects.toThrow(/HTTP 404/);
  });
});
