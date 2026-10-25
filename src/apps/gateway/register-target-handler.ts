import { z } from 'zod'
import type { RegistrationOutcome, TargetRegistrar } from '../../core/registry/target-registrar.ts'
import type { Logger } from '../../core/ports/logger.ts'
import type { TenantTarget } from '../../core/ports/tenant-registry.ts'
import { missingScope } from '../../core/gateway/catalog.ts'
import type { Authenticator } from '../shared/bearer-auth.ts'
import { newTraceId, traceIdFrom, traceparentFor } from '../shared/trace.ts'

export const REGISTRY_ADMIN_SCOPE = 'registry:admin'

/** The HTTP request as this handler needs it, independent of Express or Lambda. */
export interface RegisterTargetEvent {
  authorization: string | undefined
  traceparent: string | undefined
  body: unknown
}

export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: unknown
}

// LEARN: .strict() rejects unknown fields, tenant_id included. The tenant is
// taken from the verified token; accepting a tenant_id in the body (even to
// ignore it) invites a future change that starts trusting it.
const bodySchema = z
  .object({
    target_id: z.string().min(1).max(63),
    name: z.string().min(1).max(100),
    base_url: z.url(),
    auth_type: z.literal('api_key'),
    api_key: z.string().min(8).max(512),
  })
  .strict()

/** POST /admin/targets: a tenant admin registers one of the tenant's own MCP servers. */
export class RegisterTargetHandler {
  private readonly authenticator: Authenticator
  private readonly registrar: TargetRegistrar
  private readonly logger: Logger

  constructor(authenticator: Authenticator, registrar: TargetRegistrar, logger: Logger) {
    this.authenticator = authenticator
    this.registrar = registrar
    this.logger = logger
  }

  async handle(event: RegisterTargetEvent): Promise<HttpResult> {
    const traceId = traceIdFrom(event.traceparent) ?? newTraceId()
    let logger = this.logger.child({ trace_id: traceId })

    const auth = await this.authenticator.authenticate(event.authorization)
    if (!auth.ok) {
      logger.info('admin request rejected', { status: auth.status, reason: auth.reason })
      return { status: auth.status, headers: auth.headers, body: auth.body }
    }
    const caller = auth.principal
    logger = logger.child({ tenant_id: caller.tenantId, sub: caller.subject })

    if (missingScope(caller, REGISTRY_ADMIN_SCOPE)) {
      logger.info('admin request denied', { required_scope: REGISTRY_ADMIN_SCOPE })
      return {
        status: 403,
        headers: { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${REGISTRY_ADMIN_SCOPE}"` },
        body: { error: 'insufficient_scope', error_description: `requires scope ${REGISTRY_ADMIN_SCOPE}` },
      }
    }

    const parsed = bodySchema.safeParse(event.body)
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      return badRequest(issues.join('; '))
    }
    const body = parsed.data

    try {
      const outcome = await this.registrar.register(
        caller,
        {
          targetId: body.target_id,
          name: body.name,
          baseUrl: body.base_url,
          authType: body.auth_type,
          apiKey: body.api_key,
        },
        { traceparent: traceparentFor(traceId), logger },
      )
      return toHttp(outcome)
    } catch (err) {
      logger.error('target registration failed', { err })
      return { status: 500, headers: {}, body: { error: 'server_error' } }
    }
  }
}

function toHttp(outcome: RegistrationOutcome): HttpResult {
  switch (outcome.kind) {
    case 'created':
      return { status: 201, headers: {}, body: view(outcome.target) }
    case 'existing':
      return { status: 200, headers: {}, body: view(outcome.target) }
    case 'conflict':
      return {
        status: 409,
        headers: {},
        body: { error: 'conflict', error_description: 'target_id already registered with a different definition' },
      }
    case 'quota_exceeded':
      // The RFC: exceeding a tenant quota returns 429 to that tenant only.
      return {
        status: 429,
        headers: {},
        body: { error: 'quota_exceeded', error_description: 'maximum number of targets reached' },
      }
    case 'unknown_tenant':
      return { status: 404, headers: {}, body: { error: 'unknown_tenant', error_description: 'tenant not onboarded' } }
    case 'invalid':
      return badRequest(outcome.reason)
  }
}

function badRequest(description: string): HttpResult {
  return { status: 400, headers: {}, body: { error: 'invalid_request', error_description: description } }
}

/** What the admin sees. secret_ref is a pointer; the secret itself is never returned. */
function view(target: TenantTarget) {
  return {
    target_id: target.targetId,
    name: target.name,
    base_url: target.baseUrl,
    auth_type: target.authType,
    secret_ref: target.secretRef,
    status: target.status,
    ...(target.statusReason ? { status_reason: target.statusReason } : {}),
    version: target.version,
    created_at: target.createdAt,
  }
}
