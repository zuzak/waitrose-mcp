import { describe, it, expect, vi, beforeEach } from "vitest";
import WaitroseClient, { extractSubCategoriesFromBrowsePage, slugifyCategoryName } from "../waitrose.js";

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

// Build a HTML fixture matching the real Waitrose page shape: a script tag
// containing window.__PRELOADED_STATE__ = JSON.parse('<json-string-literal>')
function buildBrowsePageHtml(state: unknown): string {
  // First JSON-encode the state, then escape so it can sit inside a JS
  // single-quoted string (which is what Waitrose actually emits).
  const json = JSON.stringify(state);
  const jsLiteral = json
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
  return `<html><body><script nonce="x">window.__PRELOADED_STATE__ = JSON.parse('${jsLiteral}');</script></body></html>`;
}

describe("slugifyCategoryName", () => {
  it("lowercases and replaces & with and, drops commas, spaces become underscores", () => {
    expect(slugifyCategoryName("Bakery")).toBe("bakery");
    expect(slugifyCategoryName("Fresh & Chilled")).toBe("fresh_and_chilled");
    expect(slugifyCategoryName("Beer, Wine & Spirits")).toBe("beer_wine_and_spirits");
    expect(slugifyCategoryName("Tea, Coffee & Soft Drinks")).toBe("tea_coffee_and_soft_drinks");
  });
});

describe("extractSubCategoriesFromBrowsePage", () => {
  it("extracts subCategories from a typical state blob", () => {
    const state = {
      offers: {
        subCategories: [
          { name: "Bakery", categoryId: "300119", expectedResults: 553, hiddenInNav: false },
          { name: "Frozen", categoryId: "300000", expectedResults: 567, hiddenInNav: false },
        ],
      },
    };
    const subs = extractSubCategoriesFromBrowsePage(buildBrowsePageHtml(state));
    expect(subs).toHaveLength(2);
    expect(subs?.[0]).toMatchObject({ name: "Bakery", categoryId: "300119" });
  });

  it("returns null when the preloaded-state script is absent", () => {
    expect(extractSubCategoriesFromBrowsePage("<html><body></body></html>")).toBeNull();
  });

  it("returns null when no subCategories are present anywhere in the state", () => {
    const html = buildBrowsePageHtml({ random: { other: "data" } });
    expect(extractSubCategoriesFromBrowsePage(html)).toBeNull();
  });

  it("walks past empty subCategories arrays to find the populated one", () => {
    const state = {
      a: { subCategories: [] },
      b: { nested: { subCategories: [{ name: "Bread", categoryId: "1", expectedResults: 10 }] } },
    };
    const subs = extractSubCategoriesFromBrowsePage(buildBrowsePageHtml(state));
    expect(subs).toHaveLength(1);
    expect(subs?.[0].name).toBe("Bread");
  });
});

describe("getCategoryNavigation", () => {
  let client: WaitroseClient;

  beforeEach(() => {
    client = new WaitroseClient();
    vi.restoreAllMocks();
  });

  it("fetches the browse page and maps subCategories to CategoryNavEntry", async () => {
    const state = {
      offers: {
        subCategories: [
          { name: "Fresh & Chilled", categoryId: "301134", expectedResults: 3527, hiddenInNav: false },
          { name: "Bakery", categoryId: "300119", expectedResults: 553, hiddenInNav: false },
        ],
      },
    };
    const html = buildBrowsePageHtml(state);

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://www.waitrose.com/ecom/shop/browse/groceries");
      return { ok: true, status: 200, text: async () => html } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getCategoryNavigation();

    expect(result).toEqual([
      { name: "Fresh & Chilled", categoryId: "301134", path: "groceries/fresh_and_chilled", productCount: 3527 },
      { name: "Bakery", categoryId: "300119", path: "groceries/bakery", productCount: 553 },
    ]);
  });

  it("uses canonical url from state blob when present, ignoring slug generation", async () => {
    const state = {
      offers: {
        subCategories: [
          {
            name: "Fresh & Chilled",
            categoryId: "301134",
            expectedResults: 3527,
            url: "/ecom/shop/browse/groceries/fresh-chilled",
          },
          {
            name: "Bakery",
            categoryId: "300119",
            expectedResults: 553,
            url: "/ecom/shop/browse/groceries/bakery",
          },
        ],
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => buildBrowsePageHtml(state),
    } as unknown as Response)));

    const result = await client.getCategoryNavigation();

    expect(result).toEqual([
      { name: "Fresh & Chilled", categoryId: "301134", path: "groceries/fresh-chilled", productCount: 3527 },
      { name: "Bakery", categoryId: "300119", path: "groceries/bakery", productCount: 553 },
    ]);
  });

  it("uses the provided parent path and joins children under it", async () => {
    const state = {
      offers: {
        subCategories: [
          { name: "Bread", categoryId: "300121", expectedResults: 105, hiddenInNav: false },
        ],
      },
    };
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://www.waitrose.com/ecom/shop/browse/groceries/bakery");
      return { ok: true, status: 200, text: async () => buildBrowsePageHtml(state) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await client.getCategoryNavigation("groceries/bakery");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "Bread", path: "groceries/bakery/bread", productCount: 105 });
  });

  it("throws on non-2xx HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, text: async () => "" } as unknown as Response)));
    await expect(client.getCategoryNavigation("groceries/bogus")).rejects.toThrow(/HTTP 404/);
  });

  it("returns an empty array when the page has no subCategories", async () => {
    const html = buildBrowsePageHtml({ unrelated: "state" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => html } as unknown as Response)));
    expect(await client.getCategoryNavigation()).toEqual([]);
  });
});
