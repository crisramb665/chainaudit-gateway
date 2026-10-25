import type { AccessTokenSigner } from '../ports/access-token-signer.ts'
import type { Clock } from '../ports/clock.ts'
import { CLIENT_CREDENTIALS, TOKEN_EXCHANGE, type ClientRegistry, type OAuthClient } from '../ports/client-registry.ts'
import type { JwtVerifier } from '../ports/jwt-verifier.ts'
import type { Logger } from '../ports/logger.ts'
import type { SecretVerifier } from '../ports/secret-verifier.ts'
import type { Principal } from '../ports/token-verifier.ts'

/** RFC 6749 §5.2 and RFC 8693 §2.2.2 error codes. The HTTP layer maps them to statuses. */
export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'server_error'

export interface TokenRequest {
  clientId: string
  clientSecret: string
  /** The form parameters of the token request. */
  params: Record<string, unknown>
}

export type TokenOutcome =
  { ok: true; body: Record<string, unknown> } | { ok: false; error: OAuthErrorCode; description: string }

export interface TokenPolicy {
  /** aud of client credentials tokens (the gateway). */
  audience: string
  ttlSeconds: number
  // Tokens minted by token exchange for one hop live shorter than agent tokens.
  exchangeTtlSeconds: number
}

/** What the token endpoint needs from core. */
export interface TokenIssuer {
  issue(request: TokenRequest, logger: Logger): Promise<TokenOutcome>
}

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

// LEARN: Unknown client and wrong secret get the same code and message, and
// the SecretVerifier spends the same work on both, so they also take about the
// same time. Distinct answers would let an attacker enumerate valid client ids
// before attacking their secrets.
const INVALID_CLIENT = fail('invalid_client', 'Client authentication failed')

/** Client credentials (RFC 6749 §4.4) and token exchange (RFC 8693). */
export class DefaultTokenIssuer implements TokenIssuer {
  private readonly clients: ClientRegistry
  private readonly secrets: SecretVerifier
  private readonly signer: AccessTokenSigner
  private readonly subjects: JwtVerifier
  private readonly clock: Clock
  private readonly policy: TokenPolicy

  constructor(
    clients: ClientRegistry,
    secrets: SecretVerifier,
    signer: AccessTokenSigner,
    subjects: JwtVerifier,
    clock: Clock,
    policy: TokenPolicy,
  ) {
    this.clients = clients
    this.secrets = secrets
    this.signer = signer
    this.subjects = subjects
    this.clock = clock
    this.policy = policy
  }

  async issue(request: TokenRequest, rootLogger: Logger): Promise<TokenOutcome> {
    const found = this.clients.findClient(request.clientId)
    const valid = await this.secrets.verify(request.clientSecret, found?.secret_hash)
    const client = valid ? found : undefined
    if (!client) {
      rootLogger.info('token denied', { client_id: request.clientId, reason: 'invalid_client' })
      return INVALID_CLIENT
    }
    const logger = rootLogger.child({ client_id: client.client_id, tenant_id: client.tenant_id })

    const grantType = request.params.grant_type
    if (typeof grantType !== 'string' || grantType === '') return fail('invalid_request', 'grant_type is required')
    if (grantType !== CLIENT_CREDENTIALS && grantType !== TOKEN_EXCHANGE) {
      return fail('unsupported_grant_type', `Unsupported grant_type ${grantType}`)
    }
    // LEARN: Each client may use only the grants it was registered for. Agents
    // cannot exchange tokens (or they could mint tokens for any target), and the
    // gateway cannot get tokens of its own, only tokens derived from a caller's.
    if (!client.allowed_grant_types.includes(grantType)) {
      logger.info('token denied', { reason: 'unauthorized_client', grant_type: grantType })
      return fail('unauthorized_client', 'This client may not use this grant type')
    }

    return grantType === TOKEN_EXCHANGE
      ? this.tokenExchange(client, request.params, logger)
      : this.clientCredentials(client, request.params, logger)
  }

  private async clientCredentials(
    client: OAuthClient,
    params: Record<string, unknown>,
    logger: Logger,
  ): Promise<TokenOutcome> {
    // Guaranteed by the clients file schema for client_credentials clients.
    if (!client.tenant_id) return fail('server_error', 'Client is misconfigured')

    const scopes = resolveScopes(params.scope, client.allowed_scopes)
    if (!scopes) {
      logger.info('token denied', { reason: 'invalid_scope', requested_scope: params.scope })
      return fail('invalid_scope', 'Requested scope exceeds the scopes allowed for this client')
    }

    const scope = scopes.join(' ')
    const issuedAt = this.clock.nowSeconds()
    const { token, jti } = await this.signer.sign({
      audience: this.policy.audience,
      subject: client.client_id,
      tenantId: client.tenant_id,
      scope,
      issuedAt,
      expiresAt: issuedAt + this.policy.ttlSeconds,
    })

    logger.info('token issued', { jti, scope, expires_in: this.policy.ttlSeconds })
    return {
      ok: true,
      body: { access_token: token, token_type: 'Bearer', expires_in: this.policy.ttlSeconds, scope },
    }
  }

  /** The gateway trades the agent's token for a new, narrower one addressed to a single target. */
  private async tokenExchange(
    client: OAuthClient,
    params: Record<string, unknown>,
    logger: Logger,
  ): Promise<TokenOutcome> {
    const { subject_token, subject_token_type, requested_token_type, audience, scope } = params
    if (typeof subject_token !== 'string' || subject_token === '') {
      return fail('invalid_request', 'subject_token is required')
    }
    if (subject_token_type !== ACCESS_TOKEN_TYPE) {
      return fail('invalid_request', `subject_token_type must be ${ACCESS_TOKEN_TYPE}`)
    }
    if (requested_token_type !== undefined && requested_token_type !== ACCESS_TOKEN_TYPE) {
      return fail('invalid_request', `requested_token_type must be ${ACCESS_TOKEN_TYPE}`)
    }
    if (typeof audience !== 'string' || audience === '') return fail('invalid_request', 'audience is required')
    // LEARN: An allow list of audiences per actor. Without it the gateway could
    // mint tokens for any service that trusts this issuer.
    if (!client.allowed_audiences?.includes(audience)) {
      logger.info('token exchange denied', { reason: 'invalid_target', audience })
      return fail('invalid_target', 'This client may not request tokens for that audience')
    }

    // LEARN: The subject token must be addressed to the client exchanging it.
    // The gateway can exchange tokens agents sent to the gateway, but a target
    // that receives an exchanged token cannot exchange it again, and nobody who
    // merely holds an agent token can turn it into tokens for other services.
    // A subject that already has `act` is refused so delegation chains cannot grow.
    const subject = await this.verifySubject(client, subject_token)
    if (!subject.ok) {
      logger.info('token exchange denied', { reason: 'invalid_subject_token', detail: subject.reason })
      return fail('invalid_request', 'subject token is invalid')
    }
    const claims = subject.principal

    // LEARN: Scopes only shrink along the chain. The actor names exactly what it
    // needs, and asking for anything the caller does not have fails instead of
    // being silently dropped, so a bug that over-asks is visible.
    if (typeof scope !== 'string' || scope.trim() === '') return fail('invalid_request', 'scope is required')
    const requested = [...new Set(scope.split(' ').filter(Boolean))]
    if (!requested.every((s) => claims.scopes.includes(s))) {
      logger.info('token exchange denied', { reason: 'invalid_scope', requested_scope: scope, sub: claims.subject })
      return fail('invalid_scope', 'Requested scope exceeds the scope of the subject token')
    }

    const issuedAt = this.clock.nowSeconds()
    // Never outlive the token it was derived from.
    const expiresAt = Math.min(issuedAt + this.policy.exchangeTtlSeconds, claims.expiresAt)
    const granted = requested.join(' ')
    const { token, jti } = await this.signer.sign({
      audience,
      // sub and tenant_id come from the caller, not from the gateway: the
      // target acts with the agent's authority, and act records who relayed it.
      subject: claims.subject,
      tenantId: claims.tenantId,
      scope: granted,
      actor: client.client_id,
      issuedAt,
      expiresAt,
    })

    logger.info('token exchanged', {
      jti,
      sub: claims.subject,
      tenant_id: claims.tenantId,
      audience,
      scope: granted,
      expires_in: expiresAt - issuedAt,
    })
    return {
      ok: true,
      body: {
        access_token: token,
        issued_token_type: ACCESS_TOKEN_TYPE,
        token_type: 'Bearer',
        expires_in: expiresAt - issuedAt,
        scope: granted,
      },
    }
  }

  private async verifySubject(
    client: OAuthClient,
    token: string,
  ): Promise<{ ok: true; principal: Principal } | { ok: false; reason: string }> {
    if (!client.subject_audience) return { ok: false, reason: 'client has no subject_audience' }
    try {
      const principal = await this.subjects.verify(token, client.subject_audience)
      if (principal.actor !== undefined) return { ok: false, reason: 'subject token is already delegated' }
      return { ok: true, principal }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'verification failed' }
    }
  }
}

function fail(error: OAuthErrorCode, description: string): TokenOutcome {
  return { ok: false, error, description }
}

/** Granted scopes, or undefined when the request asks for more than allowed. */
function resolveScopes(requested: unknown, allowed: string[]): string[] | undefined {
  if (requested !== undefined && typeof requested !== 'string') return undefined
  const asked = [...new Set((requested ?? '').split(' ').filter(Boolean))]
  // RFC 6749 §3.3: without a scope parameter the server applies a default,
  // here every scope the client is allowed.
  if (asked.length === 0) return allowed
  return asked.every((scope) => allowed.includes(scope)) ? asked : undefined
}
