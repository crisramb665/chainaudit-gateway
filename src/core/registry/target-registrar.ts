import type { EgressValidator } from '../egress/egress-validator.ts'
import { TargetCallError } from '../errors.ts'
import type { RequestContext } from '../gateway/gateway-service.ts'
import type { Clock } from '../ports/clock.ts'
import type { CredentialProvider } from '../ports/credential-provider.ts'
import type { TargetClient } from '../ports/target-client.ts'
import type { TargetStatus, TenantRegistry, TenantTarget } from '../ports/tenant-registry.ts'
import type { Principal } from '../ports/token-verifier.ts'
import { ID_PATTERN, secretRefFor } from './secret-ref.ts'

export interface TargetRegistration {
  targetId: string
  name: string
  baseUrl: string
  authType: 'api_key'
  apiKey: string
}

export type RegistrationOutcome =
  | { kind: 'created' | 'existing'; target: TenantTarget }
  | { kind: 'conflict'; target: TenantTarget }
  | { kind: 'quota_exceeded' | 'unknown_tenant' }
  | { kind: 'invalid'; reason: string }

/** What the admin API needs from core. */
export interface TargetRegistrar {
  /** Registers a target for the caller's tenant; the tenant comes only from `caller`. */
  register(caller: Principal, registration: TargetRegistration, context: RequestContext): Promise<RegistrationOutcome>
}

export interface RegistrarOptions {
  /** Platform target ids; a tenant target with the same id would make namespaced names ambiguous. */
  reservedTargetIds: string[]
}

export class DefaultTargetRegistrar implements TargetRegistrar {
  private readonly registry: TenantRegistry
  private readonly credentials: CredentialProvider
  private readonly targetClient: TargetClient
  private readonly egress: EgressValidator
  private readonly clock: Clock
  private readonly options: RegistrarOptions

  constructor(
    registry: TenantRegistry,
    credentials: CredentialProvider,
    targetClient: TargetClient,
    egress: EgressValidator,
    clock: Clock,
    options: RegistrarOptions,
  ) {
    this.registry = registry
    this.credentials = credentials
    this.targetClient = targetClient
    this.egress = egress
    this.clock = clock
    this.options = options
  }

  async register(
    caller: Principal,
    registration: TargetRegistration,
    context: RequestContext,
  ): Promise<RegistrationOutcome> {
    const tenantId = caller.tenantId
    if (!ID_PATTERN.test(registration.targetId)) {
      return { kind: 'invalid', reason: 'target_id must be a lowercase slug (a-z, 0-9, -)' }
    }
    if (this.options.reservedTargetIds.includes(registration.targetId)) {
      return { kind: 'invalid', reason: `target_id ${registration.targetId} is reserved` }
    }
    // Egress check before anything is stored or called: HTTPS, a hostname on
    // the tenant's allowed domains, and only public addresses behind it.
    const settings = await this.registry.getTenantSettings(tenantId)
    if (!settings) return { kind: 'unknown_tenant' }
    const egress = await this.egress.validate(registration.baseUrl, settings.allowedDomains)
    if (!egress.ok) {
      context.logger.info('target registration refused', { target_id: registration.targetId, reason: egress.reason })
      return { kind: 'invalid', reason: egress.reason }
    }

    const target: TenantTarget = {
      tenantId,
      targetId: registration.targetId,
      name: registration.name,
      baseUrl: registration.baseUrl,
      authType: registration.authType,
      secretRef: secretRefFor(tenantId, registration.targetId),
      status: 'pending',
      version: 1,
      createdAt: new Date(this.clock.nowSeconds() * 1000).toISOString(),
    }

    const created = await this.registry.createTarget(target)
    if (created === 'quota_exceeded' || created === 'unknown_tenant') {
      context.logger.info('target registration refused', { target_id: target.targetId, reason: created })
      return { kind: created }
    }

    if (created === 'duplicate') {
      // LEARN: Idempotent registration. Retrying the same request (a timeout
      // on the client side, a double click) returns the existing target
      // instead of failing or creating a second one. A different definition
      // under the same id is a real conflict and is refused, not overwritten.
      const existing = await this.registry.getTarget(tenantId, target.targetId)
      if (!existing) throw new Error('target reported as duplicate but not found')
      if (!sameDefinition(existing, target)) return { kind: 'conflict', target: existing }
      if (existing.status !== 'pending') return { kind: 'existing', target: existing }
      // Still pending: the retry may carry a corrected key, so store it and probe again.
      await this.credentials.putSecret(caller, existing.secretRef, registration.apiKey)
      return { kind: 'existing', target: await this.probe(existing, registration.apiKey, egress.addresses, context) }
    }

    // The registry stores only secret_ref; the secret itself goes to the credential store.
    await this.credentials.putSecret(caller, target.secretRef, registration.apiKey)
    context.logger.info('target registered', { target_id: target.targetId, status: target.status })
    return { kind: 'created', target: await this.probe(target, registration.apiKey, egress.addresses, context) }
  }

  // LEARN: A target starts pending and only an end-to-end probe (initialize
  // plus tools/list, with the stored credential) makes it active. Routing only
  // uses active targets, so a typo in the URL or a wrong key never reaches agents.
  private async probe(
    target: TenantTarget,
    apiKey: string,
    connectTo: string[],
    context: RequestContext,
  ): Promise<TenantTarget> {
    let status: TargetStatus = 'active'
    let reason: string | undefined
    try {
      const tools = await this.targetClient.listTools(
        { id: target.targetId, url: target.baseUrl },
        // The probe connects only to the addresses that just passed validation.
        { credential: { kind: 'api_key', key: apiKey }, traceparent: context.traceparent, connectTo },
      )
      context.logger.info('target probe passed', { target_id: target.targetId, tools: tools.length })
    } catch (err) {
      status = 'pending'
      reason = `health probe failed: ${err instanceof TargetCallError ? err.message : 'unexpected error'}`
      context.logger.info('target probe failed', { target_id: target.targetId, reason, err })
    }

    // LEARN: Optimistic concurrency. The update only applies if the version is
    // still the one we read; if another writer got there first, we return what
    // is stored now instead of silently overwriting it.
    const updated = await this.registry.updateTargetStatus(
      target.tenantId,
      target.targetId,
      target.version,
      status,
      reason,
    )
    if (updated !== 'version_conflict') return updated
    context.logger.info('target status changed concurrently', { target_id: target.targetId })
    return (await this.registry.getTarget(target.tenantId, target.targetId)) ?? target
  }
}

function sameDefinition(a: TenantTarget, b: TenantTarget): boolean {
  return a.name === b.name && a.baseUrl === b.baseUrl && a.authType === b.authType
}
