// LEARN: DefaultGatewayService depends only on ports: a TokenExchanger, a
// TargetClient, a TenantTargetReader and a CredentialProvider. The test passes
// fakes that record what they were asked, so it can prove security properties
// (the target is never called without the scope; the exchanged token asks for
// exactly one scope; one tenant never sees another's targets; a tenant target
// gets an API key, never a token) without an issuer, DynamoDB, an MCP server
// or any HTTP. Constructor injection is what makes that possible.
import { describe, expect, it } from 'vitest'
import { DefaultEgressValidator } from '../egress/egress-validator.ts'
import { CredentialAccessDeniedError, TargetCallError } from '../errors.ts'
import type { CredentialProvider } from '../ports/credential-provider.ts'
import type { DnsResolver } from '../ports/dns-resolver.ts'
import type { Logger } from '../ports/logger.ts'
import type {
  TargetCallContext,
  TargetClient,
  TargetEndpoint,
  ToolDefinition,
  ToolResult,
} from '../ports/target-client.ts'
import type { TenantSettings, TenantTarget, TenantTargetReader } from '../ports/tenant-registry.ts'
import type { ExchangedToken, TokenExchanger, TokenExchangeRequest } from '../ports/token-exchanger.ts'
import type { Principal } from '../ports/token-verifier.ts'
import { CircuitBreakers } from '../resilience/circuit-breakers.ts'
import { DefaultGatewayService } from './gateway-service.ts'
import type { TargetConfig } from './targets.ts'

const PLATFORM: TargetConfig = {
  id: 'chain',
  url: 'http://chain.invalid/mcp',
  audience: 'chainaudit-mcp',
  toolScopes: { get_balance: 'chain:read' },
}

const ACME_NOTES: TenantTarget = {
  tenantId: 'acme',
  targetId: 'notes',
  name: 'Client notes',
  baseUrl: 'https://notes.example.com/mcp',
  authType: 'api_key',
  secretRef: '/tenants/acme/targets/notes',
  status: 'active',
  version: 2,
  createdAt: '2026-10-25T00:00:00.000Z',
}

const GLOBEX_LEDGER: TenantTarget = {
  ...ACME_NOTES,
  tenantId: 'globex',
  targetId: 'ledger',
  baseUrl: 'https://ledger.example.com/mcp',
  secretRef: '/tenants/globex/targets/ledger',
}

class FakeTokenExchanger implements TokenExchanger {
  readonly requests: TokenExchangeRequest[] = []

  async exchange(request: TokenExchangeRequest): Promise<ExchangedToken> {
    this.requests.push(request)
    return { accessToken: `token-for-${request.audience}`, expiresAt: 2_000_000_000 }
  }
}

/** Answers per target id and records every call. */
class FakeTargetClient implements TargetClient {
  readonly calls: Array<{ target: string; tool: string; context: TargetCallContext }> = []
  /** Target ids that time out, like a target behind a 3 s latency toxic. */
  readonly failing = new Set<string>()
  private readonly toolsByTarget: Record<string, ToolDefinition[]>

  constructor(toolsByTarget: Record<string, ToolDefinition[]>) {
    this.toolsByTarget = toolsByTarget
  }

  async listTools(target: TargetEndpoint): Promise<ToolDefinition[]> {
    return this.toolsByTarget[target.id] ?? []
  }

  async callTool(target: TargetEndpoint, context: TargetCallContext, tool: string): Promise<ToolResult> {
    this.calls.push({ target: target.id, tool, context })
    if (this.failing.has(target.id)) throw new TargetCallError('timeout', 'timed out')
    return { content: [{ type: 'text', text: 'ok' }] }
  }
}

/** Plays the registry: only acme has a target. */
class FakeTenantTargets implements TenantTargetReader {
  readonly askedFor: string[] = []

  async listActiveTargets(tenantId: string): Promise<TenantTarget[]> {
    this.askedFor.push(tenantId)
    return tenantId === 'acme' ? [ACME_NOTES] : [GLOBEX_LEDGER]
  }

  async getTenantSettings(tenantId: string): Promise<TenantSettings | undefined> {
    return { allowedDomains: ['example.com'], maxTargets: 3 }
  }
}

/** DNS under the test's control: `answer` can change between calls, like a rebinding attacker's server. */
class FakeResolver implements DnsResolver {
  answer = ['93.184.216.34']

  async resolve(): Promise<string[]> {
    return this.answer
  }
}

/** Plays the credential store, including its tenant check. */
class FakeCredentials implements CredentialProvider {
  async getSecret(caller: Principal, secretRef: string): Promise<string> {
    if (!secretRef.startsWith(`/tenants/${caller.tenantId}/`)) throw new CredentialAccessDeniedError()
    return 'acme-sample-key'
  }

  async putSecret(): Promise<void> {}
}

const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger }
const context = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', logger: silentLogger }

function caller(scopes: string[], tenantId = 'acme') {
  const principal: Principal = { subject: `agent-${tenantId}`, tenantId, scopes, tokenId: 'jti-1', expiresAt: 0 }
  return { principal, subjectToken: 'agent-token' }
}

const clock = { nowSeconds: () => 1_800_000_000 }

function build(toolsByTarget: Record<string, ToolDefinition[]> = {}) {
  const exchanger = new FakeTokenExchanger()
  const targets = new FakeTargetClient(toolsByTarget)
  const tenantTargets = new FakeTenantTargets()
  const resolver = new FakeResolver()
  // The real validator, with fake DNS.
  const egress = new DefaultEgressValidator(resolver, { allowPrivateNetworks: false })
  const gateway = new DefaultGatewayService(
    exchanger,
    targets,
    [PLATFORM],
    tenantTargets,
    new FakeCredentials(),
    egress,
    new CircuitBreakers(clock, { windowSize: 10, failureRate: 0.5, openSeconds: 15 }),
    { tenantTargetTimeoutMs: 2000 },
  )
  return { gateway, exchanger, targets, tenantTargets, resolver }
}

describe('DefaultGatewayService (gateway core)', () => {
  it('lists namespaced tools and hides tools missing from the scope map', async () => {
    const { gateway } = build({ chain: [{ name: 'get_balance' }, { name: 'admin_reset' }] })

    const tools = await gateway.listTools(caller(['chain:read']), context)

    expect(tools.map((t) => t.name)).toEqual(['chain__get_balance'])
  })

  it('refuses a call without the scope and never reaches the target', async () => {
    const { gateway, exchanger, targets } = build()

    const result = await gateway.callTool(caller(['recon:read']), 'chain__get_balance', {}, context)

    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Tool chain__get_balance requires scope chain:read' }],
    })
    expect(exchanger.requests).toEqual([])
    expect(targets.calls).toEqual([])
  })

  it('exchanges for exactly the tool scope and the target audience, never forwarding the agent token', async () => {
    const { gateway, exchanger, targets } = build()

    await gateway.callTool(caller(['chain:read', 'recon:read', 'recon:write']), 'chain__get_balance', {}, context)

    expect(exchanger.requests).toEqual([
      { subjectToken: 'agent-token', subjectTokenId: 'jti-1', audience: 'chainaudit-mcp', scopes: ['chain:read'] },
    ])
    expect(targets.calls).toEqual([
      {
        target: 'chain',
        tool: 'get_balance',
        context: {
          credential: { kind: 'bearer', token: 'token-for-chainaudit-mcp' },
          traceparent: context.traceparent,
        },
      },
    ])
  })

  it("shows a tenant's own targets only to that tenant", async () => {
    const tools = { chain: [{ name: 'get_balance' }], notes: [{ name: 'get_client_note' }] }

    const acme = await build(tools).gateway.listTools(caller(['chain:read', 'tenant:tools']), context)
    const globex = build(tools)
    const globexTools = await globex.gateway.listTools(caller(['chain:read', 'tenant:tools'], 'globex'), context)

    expect(acme.map((t) => t.name)).toEqual(['chain__get_balance', 'notes__get_client_note'])
    expect(globexTools.map((t) => t.name)).not.toContain('notes__get_client_note')
    // The registry is only ever asked about the caller's own tenant.
    expect(globex.tenantTargets.askedFor).toEqual(['globex'])
  })

  it("answers Unknown tool when another tenant calls acme's target, and calls nothing", async () => {
    const { gateway, targets } = build()

    const result = await gateway.callTool(caller(['tenant:tools'], 'globex'), 'notes__get_client_note', {}, context)

    expect(result).toEqual({ isError: true, content: [{ type: 'text', text: 'Unknown tool notes__get_client_note' }] })
    expect(targets.calls).toEqual([])
  })

  it('sends the tenant API key to a tenant target, and no token at all', async () => {
    const { gateway, exchanger, targets } = build()

    await gateway.callTool(caller(['tenant:tools']), 'notes__get_client_note', {}, context)

    expect(targets.calls).toEqual([
      {
        target: 'notes',
        tool: 'get_client_note',
        context: {
          credential: { kind: 'api_key', key: 'acme-sample-key' },
          traceparent: context.traceparent,
          // Pinned to the address that was just validated, with the tenant timeout.
          connectTo: ['93.184.216.34'],
          timeoutMs: 2000,
        },
      },
    ])
    expect(exchanger.requests).toEqual([])
  })

  it('hides tenant targets without tenant:tools and refuses the call', async () => {
    const { gateway, targets } = build({ notes: [{ name: 'get_client_note' }] })

    const tools = await gateway.listTools(caller(['chain:read']), context)
    const result = await gateway.callTool(caller(['chain:read']), 'notes__get_client_note', {}, context)

    expect(tools.map((t) => t.name)).not.toContain('notes__get_client_note')
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Tool notes__get_client_note requires scope tenant:tools' }],
    })
    expect(targets.calls).toEqual([])
  })

  it('never validates or pins platform targets: they are operator config', async () => {
    const { gateway, targets, resolver } = build()
    resolver.answer = ['10.0.0.1'] // would fail validation if it were checked

    await gateway.callTool(caller(['chain:read']), 'chain__get_balance', {}, context)

    expect(targets.calls[0]?.target).toBe('chain')
    expect(targets.calls[0]?.context.connectTo).toBeUndefined()
  })

  it('stops a DNS rebinding: the name now resolves to a private IP, so nothing is called', async () => {
    const { gateway, targets, resolver } = build({ notes: [{ name: 'get_client_note' }] })
    // Public when it was registered (and when the tools were listed) ...
    const listed = await gateway.listTools(caller(['tenant:tools']), context)
    expect(listed.map((t) => t.name)).toContain('notes__get_client_note')

    // ... and the attacker's DNS answers with an internal address for the call.
    resolver.answer = ['93.184.216.34', '10.0.0.5']
    const result = await gateway.callTool(caller(['tenant:tools']), 'notes__get_client_note', {}, context)

    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Target notes failed egress validation' }],
    })
    expect(targets.calls).toEqual([])
  })

  it("opens only acme's breaker for its failing target; acme's platform tool and globex keep working", async () => {
    const { gateway, targets } = build()
    targets.failing.add('notes')
    const acme = caller(['chain:read', 'tenant:tools'])

    for (let i = 0; i < 10; i++) await gateway.callTool(acme, 'notes__get_client_note', {}, context)
    const callsBefore = targets.calls.length
    const open = await gateway.callTool(acme, 'notes__get_client_note', {}, context)

    expect(open).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'Target notes is temporarily unavailable (circuit open)' }],
    })
    expect(targets.calls.length).toBe(callsBefore) // rejected without calling the target

    await gateway.callTool(acme, 'chain__get_balance', {}, context)
    await gateway.callTool(caller(['tenant:tools'], 'globex'), 'ledger__get_client_note', {}, context)
    expect(targets.calls.slice(callsBefore).map((c) => c.target)).toEqual(['chain', 'ledger'])
  })
})
