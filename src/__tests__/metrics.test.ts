import { describe, it, expect } from "vitest";
import { registry, toolCallsTotal, toolCallDuration, upstreamCallsTotal, sessionAuthenticated } from "../metrics.js";

describe("metrics registration", () => {
  it("exports all four required metrics", async () => {
    const metrics = await registry.metrics();
    expect(metrics).toContain("waitrose_mcp_tool_calls_total");
    expect(metrics).toContain("waitrose_mcp_tool_call_duration_seconds");
    expect(metrics).toContain("waitrose_mcp_upstream_calls_total");
    expect(metrics).toContain("waitrose_mcp_session_authenticated");
  });

  it("tool calls counter increments correctly", async () => {
    toolCallsTotal.inc({ tool: "search_products", outcome: "ok" });
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/waitrose_mcp_tool_calls_total\{.*tool="search_products".*outcome="ok".*\} 1/);
  });

  it("session authenticated gauge can be set", async () => {
    sessionAuthenticated.set(1);
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/waitrose_mcp_session_authenticated 1/);
  });
});
