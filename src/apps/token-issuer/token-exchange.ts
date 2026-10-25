import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { Logger } from '../../core/ports/logger.ts'
import { signAccessToken } from './access-token.ts'
import type { OAuthClient } from './clients.ts'
import { NO_STORE, oauthError, type HttpResult } from './oauth-errors.ts'
import { SIGNING_ALG } from './signing-key.ts'
import type { TokenHandlerDeps } from './token-handler.ts'

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

const subjectClaimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.string().min(1),
  scope: z.string(),
  exp: z.number(),
})

/**
 * Token exchange (RFC 8693): the gateway trades the agent's token for a new,
 * narrower one addressed to a single target.
 */
export async function handleTokenExchange(
  deps: TokenHandlerDeps,
  client: OAuthClient,
  body: Record<string, unknown>,
  logger: Logger,
): Promise<HttpResult> {
  const { subject_token, subject_token_type, requested_token_type, audience, scope } = body
  if (typeof subject_token !== 'string' || subject_token === '') {
    return oauthError(400, 'invalid_request', 'subject_token is required')
  }
  if (subject_token_type !== ACCESS_TOKEN_TYPE) {
    return oauthError(400, 'invalid_request', `subject_token_type must be ${ACCESS_TOKEN_TYPE}`)
  }
  if (requested_token_type !== undefined && requested_token_type !== ACCESS_TOKEN_TYPE) {
    return oauthError(400, 'invalid_request', `requested_token_type must be ${ACCESS_TOKEN_TYPE}`)
  }
  if (typeof audience !== 'string' || audience === '') {
    return oauthError(400, 'invalid_request', 'audience is required')
  }
  // LEARN: An allow list of audiences per actor. Without it the gateway could
  // mint tokens for any service that trusts this issuer.
  if (!client.allowed_audiences?.includes(audience)) {
    logger.info('token exchange denied', { reason: 'invalid_target', audience })
    return oauthError(400, 'invalid_target', 'This client may not request tokens for that audience')
  }

  // LEARN: The subject token must be addressed to the client exchanging it.
  // The gateway can exchange tokens agents sent to the gateway, but a target
  // that receives an exchanged token cannot exchange it again, and nobody who
  // merely holds an agent token can turn it into tokens for other services.
  // A subject that already has `act` is refused so delegation chains cannot grow.
  const subject = await verifySubjectToken(deps, client, subject_token)
  if (!subject.ok) {
    logger.info('token exchange denied', { reason: 'invalid_subject_token', detail: subject.reason })
    return oauthError(400, 'invalid_request', 'subject token is invalid')
  }
  const claims = subject.claims

  // LEARN: Scopes only shrink along the chain. The actor names exactly what it
  // needs, and asking for anything the caller does not have fails instead of
  // being silently dropped, so a bug that over-asks is visible.
  if (typeof scope !== 'string' || scope.trim() === '') {
    return oauthError(400, 'invalid_request', 'scope is required')
  }
  const requested = [...new Set(scope.split(' ').filter(Boolean))]
  const held = claims.scope.split(' ').filter(Boolean)
  if (!requested.every((s) => held.includes(s))) {
    logger.info('token exchange denied', { reason: 'invalid_scope', requested_scope: scope, sub: claims.sub })
    return oauthError(400, 'invalid_scope', 'Requested scope exceeds the scope of the subject token')
  }

  const issuedAt = Math.floor(Date.now() / 1000)
  // Never outlive the token it was derived from.
  const expiresAt = Math.min(issuedAt + deps.exchangeTtlSeconds, claims.exp)
  const granted = requested.join(' ')
  const { token, jti } = await signAccessToken(deps, {
    audience,
    // sub and tenant_id come from the caller, not from the gateway: the
    // target acts with the agent's authority, and act records who relayed it.
    subject: claims.sub,
    tenantId: claims.tenant_id,
    scope: granted,
    actor: client.client_id,
    issuedAt,
    expiresAt,
  })

  logger.info('token exchanged', {
    jti,
    sub: claims.sub,
    tenant_id: claims.tenant_id,
    audience,
    scope: granted,
    expires_in: expiresAt - issuedAt,
  })
  return {
    status: 200,
    headers: NO_STORE,
    body: {
      access_token: token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: expiresAt - issuedAt,
      scope: granted,
    },
  }
}

async function verifySubjectToken(
  deps: TokenHandlerDeps,
  client: OAuthClient,
  token: string,
): Promise<{ ok: true; claims: z.infer<typeof subjectClaimsSchema> } | { ok: false; reason: string }> {
  try {
    const { payload } = await jwtVerify(token, deps.ownKeys, {
      issuer: deps.issuer,
      audience: client.subject_audience,
      algorithms: [SIGNING_ALG],
      typ: 'at+jwt',
      requiredClaims: ['sub', 'exp', 'jti', 'tenant_id', 'scope'],
    })
    if (payload.act !== undefined) return { ok: false, reason: 'subject token is already delegated' }
    const claims = subjectClaimsSchema.safeParse(payload)
    return claims.success ? { ok: true, claims: claims.data } : { ok: false, reason: 'unexpected claims' }
  } catch (err) {
    return { ok: false, reason: (err as { code?: string }).code ?? 'verification failed' }
  }
}
