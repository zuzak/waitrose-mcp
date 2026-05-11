import { describe, it, expect } from "vitest";
import { registry, toolCallsTotal, toolCallDuration, upstreamCallsTotal, sessionAuthenticated, rateLimitDeniedTotal, rateLimitQueueDepth } from "../metrics.js";

describe("metrics registration", () => {
  it("exports all required metrics", async () => {
    const metrics = await registry.metrics();
    expect(metrics).toContain("waitrose_mcp_tool_calls_total");
    expect(metrics).toContain("waitrose_mcp_tool_call_duration_seconds");
    expect(metrics).toContain("waitrose_mcp_upstream_calls_total");
    expect(metrics).toContain("waitrose_mcp_session_authenticated");
    expect(metrics).toContain("waitrose_mcp_rate_limit_denied_total");
    expect(metrics).toContain("waitrose_mcp_rate_limit_queue_depth");
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

  it("rate limit denied counter increments", async () => {
    rateLimitDeniedTotal.inc();
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/waitrose_mcp_rate_limit_denied_total \d+/);
  });

  it("rate limit queue depth gauge can be set", async () => {
    rateLimitQueueDepth.set(3);
    const metrics = await registry.metrics();
    expect(metrics).toMatch(/waitrose_mcp_rate_limit_queue_depth 3/);
  });
});
