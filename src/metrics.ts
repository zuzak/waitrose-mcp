import { Registry, Counter, Histogram, Gauge } from "prom-client";

export const registry = new Registry();

export const toolCallsTotal = new Counter({
  name: "waitrose_mcp_tool_calls_total",
  help: "Total MCP tool calls",
  labelNames: ["tool", "outcome"] as const,
  registers: [registry],
});

export const toolCallDuration = new Histogram({
  name: "waitrose_mcp_tool_call_duration_seconds",
  help: "MCP tool call duration",
  labelNames: ["tool"] as const,
  registers: [registry],
});

export const upstreamCallsTotal = new Counter({
  name: "waitrose_mcp_upstream_calls_total",
  help: "Total calls to www.waitrose.com",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const sessionAuthenticated = new Gauge({
  name: "waitrose_mcp_session_authenticated",
  help: "1 if the session is authenticated, 0 otherwise",
  registers: [registry],
});

// Pre-registered for auth resilience (issue #7 / PR #15) — incremented in
// waitrose.ts once that branch merges. Declared here so the metric exists
// in /metrics at zero-value from startup even before a reauth occurs.
export const reauthsTotal = new Counter({
  name: "waitrose_mcp_reauths_total",
  help: "Total re-authentication attempts",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
