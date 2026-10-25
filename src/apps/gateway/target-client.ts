import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { TargetConfig } from '../../core/gateway/targets.ts'

export interface TargetCallOptions {
  traceparent: string
  timeoutMs: number
}

/** Opens an MCP client to a target, runs `fn`, and always closes it. */
export async function withTargetClient<T>(
  target: TargetConfig,
  options: TargetCallOptions,
  fn: (client: Client, requestOptions: { timeout: number }) => Promise<T>,
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(target.url), {
    // TODO(task 4b): authenticate gateway -> target with a short-lived token
    // minted for this target (RFC 8693 token exchange). Never forward the
    // agent's token: the target would accept a token not addressed to it.
    requestInit: { headers: { traceparent: options.traceparent } },
    // LEARN: Two timeouts on purpose. The MCP request timeout (SDK default
    // 60 s) rejects the pending request, but does not close the socket. The
    // fetch-level AbortSignal does, so a hung target cannot hold connections.
    fetch: (url, init) => {
      const signal = AbortSignal.timeout(options.timeoutMs)
      return fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
    },
  })
  const client = new Client({ name: 'chainaudit-gateway', version: '0.1.0' })
  try {
    await client.connect(transport, { timeout: options.timeoutMs })
    return await fn(client, { timeout: options.timeoutMs })
  } finally {
    await client.close().catch(() => {})
  }
}
