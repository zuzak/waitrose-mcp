import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { redactArgs, auditLog } from "../audit.js";

describe("redactArgs", () => {
  it("passes through allowlisted fields for search_products", () => {
    const result = redactArgs("search_products", {
      query: "feta",
      size: 24,
      start: 0,
      sortBy: "RELEVANCE",
      filterTags: [{ group: "dietary", value: "vegan" }],
    });
    expect(result.query).toBe("feta");
    expect(result.size).toBe(24);
    expect(result.filterTags).toEqual([{ group: "dietary", value: "vegan" }]);
  });

  it("redacts unknown fields for search_products", () => {
    const result = redactArgs("search_products", {
      query: "milk",
      secretField: "sensitive",
    });
    expect(result.query).toBe("milk");
    expect(result.secretField).toBe("<redacted>");
  });

  it("passes through allowlisted fields for browse_products", () => {
    const result = redactArgs("browse_products", { category: "groceries/dairy", sortBy: "RELEVANCE" });
    expect(result.category).toBe("groceries/dairy");
    expect(result.sortBy).toBe("RELEVANCE");
  });

  it("passes through lineNumbers for get_products_by_line_numbers", () => {
    const result = redactArgs("get_products_by_line_numbers", { lineNumbers: ["123", "456"] });
    expect(result.lineNumbers).toEqual(["123", "456"]);
  });

  it("passes through promotionId for get_promotion_products", () => {
    const result = redactArgs("get_promotion_products", { promotionId: "myWaitrose", size: 10 });
    expect(result.promotionId).toBe("myWaitrose");
    expect(result.size).toBe(10);
  });

  it("redacts everything for unknown tool", () => {
    const result = redactArgs("unknown_tool", { query: "secret", count: 5 });
    expect(result.query).toBe("<redacted>");
    expect(result.count).toBe("<redacted>");
  });
});

describe("auditLog", () => {
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it("emits valid JSON to stderr", () => {
    auditLog({
      audit: true,
      ts: "2026-05-08T00:00:00.000Z",
      session: "test-session",
      tool: "search_products",
      args: { query: "feta" },
      outcome: "ok",
      duration_ms: 42,
    });

    expect(spy).toHaveBeenCalledOnce();
    const raw = spy.mock.calls[0][0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.audit).toBe(true);
    expect(parsed.tool).toBe("search_products");
    expect(parsed.outcome).toBe("ok");
    expect(parsed.duration_ms).toBe(42);
  });
});
