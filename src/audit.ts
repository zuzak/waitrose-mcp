/** Fields safe to include in audit logs, keyed by tool name. */
const SAFE_ARGS: Record<string, Set<string>> = {
  search_products: new Set(["query", "sortBy", "size", "start", "filterTags"]),
  browse_products: new Set(["category", "sortBy", "size", "start"]),
  get_products_by_line_numbers: new Set(["lineNumbers"]),
  get_promotion_products: new Set(["promotionId", "sortBy", "size", "start"]),
};

/** Returns a copy of args with any field not on the allowlist redacted. */
export function redactArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const safe = SAFE_ARGS[toolName];
  if (!safe) {
    // Unknown tool — redact everything (fail-closed)
    return Object.fromEntries(Object.keys(args).map((k) => [k, "<redacted>"]));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    // Safe top-level fields pass through as-is (including nested objects/arrays).
    // Redaction only applies at the top level — nested field allowlists can be
    // added per-tool in SAFE_ARGS if needed in future.
    result[key] = safe.has(key) ? value : "<redacted>";
  }
  return result;
}

export interface AuditEntry {
  audit: true;
  ts: string;
  session: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: "ok" | "error" | "denied";
  duration_ms: number;
  error?: string;
  denied?: string;
}

export function auditLog(entry: AuditEntry): void {
  console.error(JSON.stringify(entry));
}
