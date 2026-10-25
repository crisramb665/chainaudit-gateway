/** A tool as a target describes it. Only `name` matters to the gateway; the rest passes through. */
export interface ToolDefinition {
  name: string
  [key: string]: unknown
}

/** An MCP tool result. Passed through unchanged, including the target's own isError results. */
export interface ToolResult {
  isError?: boolean
  content: Array<{ type: string; [key: string]: unknown }>
  [key: string]: unknown
}

/** Where a target lives. Platform and tenant targets both reduce to this. */
export interface TargetEndpoint {
  id: string
  url: string
}

/**
 * The credential for one hop. Platform targets get a token minted for them by
 * token exchange; tenant targets get the tenant's API key. Never the caller's token.
 */
export type TargetCredential = { kind: 'bearer'; token: string } | { kind: 'api_key'; key: string }

export interface TargetCallContext {
  credential: TargetCredential
  traceparent: string
  /**
   * Tenant targets only: the IPs egress validation approved for this call.
   * The client must connect to one of these and nothing else, while keeping
   * the URL's hostname for the Host header and TLS. Platform targets omit it.
   */
  connectTo?: string[]
}

/** Talks to a backend MCP server. Throws TargetCallError on transport errors and timeouts. */
export interface TargetClient {
  listTools(target: TargetEndpoint, context: TargetCallContext): Promise<ToolDefinition[]>
  callTool(
    target: TargetEndpoint,
    context: TargetCallContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult>
}
