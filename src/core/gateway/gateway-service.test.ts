// LEARN: DefaultGatewayService depends only on ports: a TokenExchanger and a
// TargetClient. The test passes fakes that record what they were asked, so it
// can prove security properties (the target is never called without the
// scope; the exchanged token asks for exactly one scope) without an issuer,
// an MCP server or any HTTP. Constructor injection is what makes that possible.
import { describe, expect, it } from 'vitest'
import type { Logger } from '../ports/logger.ts'
import type { TargetCallContext, TargetClient, ToolDefinition, ToolResult } from '../ports/target-client.ts'
import type { ExchangedToken, TokenExchanger, TokenExchangeRequest } from '../ports/token-exchanger.ts'
import type { Principal } from '../ports/token-verifier.ts'
import { DefaultGatewayService } from './gateway-service.ts'
import type { TargetConfig } from './targets.ts'

const TARGET: TargetConfig = {
  id: 'chain',
  url: 'http://target.invalid/mcp',
  audience: 'chainaudit-mcp',
  toolScopes: { get_balance: 'chain:read' },
}

class FakeTokenExchanger implements TokenExchanger {
  readonly requests: TokenExchangeRequest[] = []

  async exchange(request: TokenExchangeRequest): Promise<ExchangedToken> {
    this.requests.push(request)
    return { accessToken: `token-for-${request.audience}`, expiresAt: 2_000_000_000 }
  }
}

class FakeTargetClient implements TargetClient {
  readonly calls: Array<{ tool: string; context: TargetCallContext }> = []
  private readonly tools: ToolDefinition[]

  constructor(tools: ToolDefinition[]) {
    this.tools = tools
  }

  async listTools(): Promise<ToolDefinition[]> {
    return this.tools
  }

  async callTool(_target: TargetConfig, context: TargetCallContext, tool: string): Promise<ToolResult> {
    this.calls.push({ tool, context })
    return { content: [{ type: 'text', text: 'ok' }] }
  }
}

const silentLogger: Logger = { info: () => {}, error: () => {}, child: () => silentLogger }
const context = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', logger: silentLogger }

function caller(scopes: string[]) {
  const principal: Principal = { subject: 'agent-acme', tenantId: 'acme', scopes, tokenId: 'jti-1', expiresAt: 0 }
  return { principal, subjectToken: 'agent-token' }
}

describe('DefaultGatewayService (gateway core)', () => {
  it('lists namespaced tools and hides tools missing from the scope map', async () => {
    const targets = new FakeTargetClient([{ name: 'get_balance' }, { name: 'admin_reset' }])
    const gateway = new DefaultGatewayService(new FakeTokenExchanger(), targets, [TARGET])

    const tools = await gateway.listTools(caller(['chain:read']), context)

    expect(tools.map((t) => t.name)).toEqual(['chain__get_balance'])
  })

  it('refuses a call without the scope and never reaches the target', async () => {
    const exchanger = new FakeTokenExchanger()
    const targets = new FakeTargetClient([])
    const gateway = new DefaultGatewayService(exchanger, targets, [TARGET])

    const result = await gateway.callTool(caller(['recon:read']), 'chain__get_balance', {}, context)

    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Tool chain__get_balance requires scope chain:read' }],
    })
    expect(exchanger.requests).toEqual([])
    expect(targets.calls).toEqual([])
  })

  it('exchanges for exactly the tool scope and the target audience, never forwarding the agent token', async () => {
    const exchanger = new FakeTokenExchanger()
    const targets = new FakeTargetClient([])
    const gateway = new DefaultGatewayService(exchanger, targets, [TARGET])

    await gateway.callTool(caller(['chain:read', 'recon:read', 'recon:write']), 'chain__get_balance', {}, context)

    expect(exchanger.requests).toEqual([
      { subjectToken: 'agent-token', subjectTokenId: 'jti-1', audience: 'chainaudit-mcp', scopes: ['chain:read'] },
    ])
    expect(targets.calls).toEqual([
      { tool: 'get_balance', context: { accessToken: 'token-for-chainaudit-mcp', traceparent: context.traceparent } },
    ])
  })
})
