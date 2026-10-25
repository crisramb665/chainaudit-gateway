import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { LookupFunction } from 'node:net'
import { Agent, fetch as undiciFetch } from 'undici'
import { TargetCallError } from '../../core/errors.ts'
import type {
  TargetCallContext,
  TargetClient,
  TargetCredential,
  TargetEndpoint,
  ToolDefinition,
  ToolResult,
} from '../../core/ports/target-client.ts'

/** Header that carries a tenant's API key to its own target. */
export const API_KEY_HEADER = 'X-Api-Key'

/** Calls backend MCP servers over Streamable HTTP, one short-lived client per call. */
export class McpTargetClient implements TargetClient {
  private readonly timeoutMs: number

  constructor(options: { timeoutMs: number }) {
    this.timeoutMs = options.timeoutMs
  }

  listTools(target: TargetEndpoint, context: TargetCallContext): Promise<ToolDefinition[]> {
    return this.withClient(target, context, async (client, options) => {
      const { tools } = await client.listTools(undefined, options)
      return tools
    })
  }

  callTool(
    target: TargetEndpoint,
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
    target: TargetEndpoint,
    context: TargetCallContext,
    fn: (client: Client, requestOptions: { timeout: number }) => Promise<T>,
  ): Promise<T> {
    // A per-call SDK client (and, for tenant targets, a per-call connection
    // pool) is this adapter's implementation, not an injected dependency.
    const pinned = context.connectTo ? pinnedAgent(context.connectTo) : undefined
    const baseFetch: FetchLike = pinned
      ? // undici's fetch and the global one share an implementation but not their
        // type declarations, hence the casts at this boundary.
        (url, init) => undiciFetch(url, { ...(init as object), dispatcher: pinned }) as unknown as Promise<Response>
      : fetch
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: {
        headers: { ...credentialHeader(context.credential), traceparent: context.traceparent },
      },
      // LEARN: Two timeouts on purpose. The MCP request timeout (SDK default
      // 60 s) rejects the pending request, but does not close the socket. The
      // fetch-level AbortSignal does, so a hung target cannot hold connections.
      fetch: (url, init) => {
        const signal = AbortSignal.timeout(this.timeoutMs)
        return baseFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })
      },
    })
    const client = new Client({ name: 'chainaudit-gateway', version: '0.1.0' })
    try {
      await client.connect(transport, { timeout: this.timeoutMs })
      return await fn(client, { timeout: this.timeoutMs })
    } catch (err) {
      throw toTargetCallError(err)
    } finally {
      await client.close().catch(() => {})
      await pinned?.close().catch(() => {})
    }
  }
}

// LEARN: Pinning the connection to validated IPs. The URL keeps the real
// hostname, so the Host header and TLS (SNI and the certificate check) still
// use the name the tenant registered; only the DNS step is replaced, by a
// lookup that can only answer with addresses egress validation approved. A
// rebinding DNS server gets no second chance to answer with a private IP.
function pinnedAgent(addresses: string[]): Agent {
  // IPv4 first: if only one address is asked for, prefer the family every server listens on.
  const entries = addresses
    .map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    .sort((x, y) => x.family - y.family)
  const lookup: LookupFunction = (_hostname, options, callback) => {
    // Node asks for all addresses when it races IPv4 and IPv6 (happy eyeballs).
    if (options.all) return callback(null, entries)
    const first = entries[0]
    if (!first) return callback(new Error('no validated address'), '', 0)
    return callback(null, first.address, first.family)
  }
  return new Agent({ connect: { lookup } })
}

function credentialHeader(credential: TargetCredential): Record<string, string> {
  return credential.kind === 'bearer'
    ? { Authorization: `Bearer ${credential.token}` }
    : { [API_KEY_HEADER]: credential.key }
}

// Coarse, safe reasons: they reach logs and the tenant admin's probe result,
// never raw messages that could carry URLs or response bodies.
function toTargetCallError(err: unknown): TargetCallError {
  if (err instanceof TargetCallError) return err
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) {
    return new TargetCallError(`rejected the credentials (HTTP ${err.code})`, { cause: err })
  }
  if (err instanceof StreamableHTTPError && typeof err.code === 'number' && err.code > 0) {
    return new TargetCallError(`answered HTTP ${err.code}`, { cause: err })
  }
  if (
    (err instanceof McpError && err.code === ErrorCode.RequestTimeout) ||
    (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))
  ) {
    return new TargetCallError('timed out', { cause: err })
  }
  const code = (err as { cause?: { code?: string } })?.cause?.code
  if (code === 'ECONNREFUSED') return new TargetCallError('connection refused', { cause: err })
  if (code === 'ENOTFOUND') return new TargetCallError('host not found', { cause: err })
  return new TargetCallError('protocol error', { cause: err })
}
