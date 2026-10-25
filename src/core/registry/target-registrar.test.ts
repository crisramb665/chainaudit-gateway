// LEARN: The registrar coordinates three ports (registry, credential store,
// target client). Faking each one lets the test pin down the rules that are
// hard to observe end to end: the secret goes to the credential store under
// the tenant's path and never into the registry, a retry is idempotent, and a
// failed probe leaves the target pending with a reason.
import { describe, expect, it } from 'vitest'
import { TargetCallError } from '../errors.ts'
import type { Clock } from '../ports/clock.ts'
import type { CredentialProvider } from '../ports/credential-provider.ts'
import type { Logger } from '../ports/logger.ts'
import type { TargetCallContext, TargetClient, TargetEndpoint, ToolDefinition } from '../ports/target-client.ts'
import type { CreateTargetResult, TargetStatus, TenantRegistry, TenantTarget } from '../ports/tenant-registry.ts'
import type { Principal } from '../ports/token-verifier.ts'
import { DefaultTargetRegistrar, type TargetRegistration } from './target-registrar.ts'

/** In-memory registry with the same contract as the DynamoDB one. */
class InMemoryRegistry implements TenantRegistry {
  readonly items = new Map<string, TenantTarget>()
  quota = 3

  async listActiveTargets(tenantId: string): Promise<TenantTarget[]> {
    return [...this.items.values()].filter((t) => t.tenantId === tenantId && t.status === 'active')
  }

  async getTarget(tenantId: string, targetId: string): Promise<TenantTarget | undefined> {
    return this.items.get(`${tenantId}/${targetId}`)
  }

  async createTarget(target: TenantTarget): Promise<CreateTargetResult> {
    const key = `${target.tenantId}/${target.targetId}`
    if (this.items.has(key)) return 'duplicate'
    if ([...this.items.values()].filter((t) => t.tenantId === target.tenantId).length >= this.quota) {
      return 'quota_exceeded'
    }
    this.items.set(key, target)
    return 'created'
  }

  async updateTargetStatus(
    tenantId: string,
    targetId: string,
    expectedVersion: number,
    status: TargetStatus,
    reason: string | undefined,
  ): Promise<TenantTarget | 'version_conflict'> {
    const key = `${tenantId}/${targetId}`
    const current = this.items.get(key)
    if (!current || current.version !== expectedVersion) return 'version_conflict'
    const { statusReason: _drop, ...rest } = current
    const next: TenantTarget = {
      ...rest,
      status,
      version: current.version + 1,
      ...(reason ? { statusReason: reason } : {}),
    }
    this.items.set(key, next)
    return next
  }
}

class RecordingCredentials implements CredentialProvider {
  readonly written: Array<{ tenant: string; ref: string; value: string }> = []

  async getSecret(): Promise<string> {
    throw new Error('not used')
  }

  async putSecret(caller: Principal, secretRef: string, value: string): Promise<void> {
    this.written.push({ tenant: caller.tenantId, ref: secretRef, value })
  }
}

class FakeProbe implements TargetClient {
  readonly probed: Array<{ target: TargetEndpoint; context: TargetCallContext }> = []
  private readonly failure: Error | undefined

  constructor(failure?: Error) {
    this.failure = failure
  }

  async listTools(target: TargetEndpoint, context: TargetCallContext): Promise<ToolDefinition[]> {
    this.probed.push({ target, context })
    if (this.failure) throw this.failure
    return [{ name: 'get_client_note' }]
  }

  async callTool(): Promise<never> {
    throw new Error('not used')
  }
}

const admin: Principal = {
  subject: 'acme-admin',
  tenantId: 'acme',
  scopes: ['registry:admin'],
  tokenId: 'j',
  expiresAt: 0,
}
const clock: Clock = { nowSeconds: () => 1_800_000_000 }
const silentLogger: Logger = { info: () => {}, error: () => {}, child: () => silentLogger }
const context = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', logger: silentLogger }
const NOTES: TargetRegistration = {
  targetId: 'notes',
  name: 'Client notes',
  baseUrl: 'http://127.0.0.1:3003/mcp',
  authType: 'api_key',
  apiKey: 'acme-sample-key',
}

function build(probe = new FakeProbe()) {
  const registry = new InMemoryRegistry()
  const credentials = new RecordingCredentials()
  const registrar = new DefaultTargetRegistrar(registry, credentials, probe, clock, { reservedTargetIds: ['chain'] })
  return { registrar, registry, credentials, probe }
}

describe('DefaultTargetRegistrar (gateway core)', () => {
  it('stores the key under the tenant path, probes with it and activates the target', async () => {
    const { registrar, credentials, probe } = build()

    const outcome = await registrar.register(admin, NOTES, context)

    expect(outcome).toMatchObject({
      kind: 'created',
      target: { tenantId: 'acme', status: 'active', version: 2, secretRef: '/tenants/acme/targets/notes' },
    })
    expect(credentials.written).toEqual([
      { tenant: 'acme', ref: '/tenants/acme/targets/notes', value: 'acme-sample-key' },
    ])
    expect(probe.probed[0]?.context.credential).toEqual({ kind: 'api_key', key: 'acme-sample-key' })
    // The registry item carries only the reference, never the secret.
    expect(JSON.stringify(outcome)).not.toContain('acme-sample-key')
  })

  it('is idempotent: the same registration again returns the existing target without new writes', async () => {
    const { registrar, credentials } = build()
    await registrar.register(admin, NOTES, context)

    const again = await registrar.register(admin, NOTES, context)

    expect(again).toMatchObject({ kind: 'existing', target: { status: 'active', version: 2 } })
    expect(credentials.written).toHaveLength(1)
  })

  it('refuses a different definition under the same id', async () => {
    const { registrar } = build()
    await registrar.register(admin, NOTES, context)

    const outcome = await registrar.register(admin, { ...NOTES, baseUrl: 'http://elsewhere.invalid/mcp' }, context)

    expect(outcome.kind).toBe('conflict')
  })

  it('reports the quota and reserved ids', async () => {
    const { registrar, registry } = build()
    registry.quota = 0

    await expect(registrar.register(admin, NOTES, context)).resolves.toEqual({ kind: 'quota_exceeded' })
    await expect(registrar.register(admin, { ...NOTES, targetId: 'chain' }, context)).resolves.toMatchObject({
      kind: 'invalid',
    })
  })

  it('leaves the target pending with the reason when the probe fails', async () => {
    const { registrar } = build(new FakeProbe(new TargetCallError('rejected the credentials (HTTP 401)')))

    const outcome = await registrar.register(admin, NOTES, context)

    expect(outcome).toMatchObject({
      kind: 'created',
      target: { status: 'pending', statusReason: 'health probe failed: rejected the credentials (HTTP 401)' },
    })
  })
})
