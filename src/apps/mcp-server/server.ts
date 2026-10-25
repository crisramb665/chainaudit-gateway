import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getBalance } from '../../core/balance/get-balance.ts'
import { DomainError } from '../../core/errors.ts'
import { missingScope } from '../../core/gateway/catalog.ts'
import type { BalanceReader, HexAddress } from '../../core/ports/balance-reader.ts'
import type { Logger } from '../../core/ports/logger.ts'
import type { Principal } from '../../core/ports/token-verifier.ts'

export interface McpServerDeps {
  balanceReader: BalanceReader
  logger: Logger
  /** The verified caller of this request; the server is built per request. */
  principal: Principal
}

// LEARN: This server owns its own policy instead of trusting the gateway's.
// If a gateway bug lets a call through, or someone reaches this server with a
// valid token by another path, the scope is still enforced here. Each hop
// validates what it receives.
const TOOL_SCOPES = { get_balance: 'chain:read' } as const

export function buildMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: 'chainaudit-mcp', version: '0.1.0' })

  server.registerTool(
    'get_balance',
    {
      title: 'Get balance',
      description: 'Native token balance of an EVM address, in wei and ether.',
      inputSchema: {
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'address must be 0x followed by 40 hex characters'),
      },
      outputSchema: { address: z.string(), wei: z.string(), ether: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address }): Promise<CallToolResult> => {
      const missing = missingScope(deps.principal, TOOL_SCOPES.get_balance)
      if (missing) {
        deps.logger.info('tool call denied', { tool: 'get_balance', required_scope: missing })
        return { isError: true, content: [{ type: 'text', text: `Tool get_balance requires scope ${missing}` }] }
      }
      try {
        // The regex above guarantees the 0x-prefixed shape.
        const result = await getBalance(deps, { address: address as HexAddress })
        return {
          structuredContent: { ...result },
          content: [{ type: 'text', text: JSON.stringify(result) }],
        }
      } catch (err) {
        return toToolError(err, deps.logger)
      }
    },
  )

  return server
}

// LEARN: This callback never throws. If it did, the SDK would turn the throw
// into an isError result containing the raw error.message, which can leak
// provider URLs or internals to the agent. Two error channels exist on
// purpose: isError results are for failures the agent can reason about
// ("provider timed out, try later"); JSON-RPC errors are for protocol
// problems (bad JSON, unknown method) that the agent's code must handle.
function toToolError(err: unknown, logger: Logger): CallToolResult {
  logger.error('get_balance failed', { err })
  const message = err instanceof DomainError ? err.message : 'Internal error while reading the balance'
  return { isError: true, content: [{ type: 'text', text: message }] }
}
