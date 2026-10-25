import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TargetConfig } from '../../core/gateway/targets.ts'
import type { TargetCallContext, TargetClient, ToolDefinition, ToolResult } from '../../core/ports/target-client.ts'

/** Calls backend MCP servers over Streamable HTTP, one short-lived client per call. */
export class McpTargetClient implements TargetClient {
  private readonly timeoutMs: number

  constructor(options: { timeoutMs: number }) {
    this.timeoutMs = options.timeoutMs
  }

  listTools(target: TargetConfig, context: TargetCallContext): Promise<ToolDefinition[]> {
    return this.withClient(target, context, async (client, options) => {
      const { tools } = await client.listTools(undefined, options)
      return tools
    })
  }

  callTool(
    target: TargetConfig,
    context: TargetCallContext,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return this.withClient(
      target,
      context,
      async (client, options) =>
        (await client.callTool({ name: tool, arguments: args }, undefined, options)) as ToolResult,
    )
  }

  /** Opens an MCP client to a target, runs `fn`, and always closes it. */
  private async withClient<T>(
    target: TargetConfig,
    context: TargetCallContext,
    fn: (client: Client, requestOptions: { timeout: number }) => Promise<T>,
  ): Promise<T> {
    // A per-call SDK client is this adapter's implementation, not an injected dependency.
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${context.accessToken}`, traceparent: context.traceparent },
      },
      // LEARN: Two timeouts on purpose. The MCP request timeout (SDK default
      // 60 s) rejects the pending request, but does not close the socket. The
      // fetch-level AbortSignal does, so a hung target cannot hold connections.
      fetch: (url, init) => {
        const signal = AbortSignal.timeout(this.timeoutMs)
        return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
      },
    })
    const client = new Client({ name: 'chainaudit-gateway', version: '0.1.0' })
    try {
      await client.connect(transport, { timeout: this.timeoutMs })
      return await fn(client, { timeout: this.timeoutMs })
    } finally {
      await client.close().catch(() => {})
    }
  }
}
