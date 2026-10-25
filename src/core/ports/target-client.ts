import type { TargetConfig } from '../gateway/targets.ts'

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

export interface TargetCallContext {
  /** A token minted for this target by token exchange, never the caller's token. */
  accessToken: string
  traceparent: string
}

/** Talks to a backend MCP server. Throws on transport errors and timeouts. */
export interface TargetClient {
  listTools(target: TargetConfig, context: TargetCallContext): Promise<ToolDefinition[]>
  callTool(
    target: TargetConfig,
    context: TargetCallContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult>
}
