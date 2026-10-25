/** A backend MCP server the gateway routes to. Task 5 loads these from the registry. */
export interface TargetConfig {
  /** Prefix of the tool names this target exposes, e.g. `chain` in `chain__get_balance`. */
  id: string
  url: string
  /** Upstream tool name to the scope required to see and call it. */
  toolScopes: Record<string, string>
}
