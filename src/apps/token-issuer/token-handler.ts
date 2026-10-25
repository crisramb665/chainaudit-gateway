import type { JWTVerifyGetKey } from 'jose'
import type { Logger } from '../../core/ports/logger.ts'
import { signAccessToken } from './access-token.ts'
import { CLIENT_CREDENTIALS, TOKEN_EXCHANGE, type ClientRegistry, type OAuthClient } from './clients.ts'
import { NO_STORE, oauthError, type HttpResult } from './oauth-errors.ts'
import { verifySecret } from './secret-hash.ts'
import type { SigningKey } from './signing-key.ts'
import { handleTokenExchange } from './token-exchange.ts'

export interface TokenHandlerDeps {
  clients: ClientRegistry
  signingKey: SigningKey
  issuer: string
  /** aud of client credentials tokens (the gateway). */
  audience: string
  ttlSeconds: number
  /** The issuer's own public keys, to verify subject tokens in token exchange. */
  ownKeys: JWTVerifyGetKey
  exchangeTtlSeconds: number
  logger: Logger
}

export interface TokenRequest {
  authorization: string | undefined
  body: Record<string, unknown>
}

// Verified against when the client id is unknown, so that path costs the same
// scrypt work as a wrong secret. An all-zero hash that no secret produces.
const DUMMY_HASH = 'scrypt$17$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// LEARN: Unknown client and wrong secret get the same status, message and
// (thanks to DUMMY_HASH) roughly the same latency. Distinct answers would let
// an attacker enumerate valid client ids before attacking their secrets.
const INVALID_CLIENT = oauthError(401, 'invalid_client', 'Client authentication failed', {
  'WWW-Authenticate': 'Basic realm="chainaudit-token-issuer"',
})

/** POST /oauth2/token: client credentials (RFC 6749 §4.4) and token exchange (RFC 8693). */
export async function handleTokenRequest(deps: TokenHandlerDeps, req: TokenRequest): Promise<HttpResult> {
  const credentials = parseBasicAuth(req.authorization)
  if (!credentials) return INVALID_CLIENT

  const client = await authenticate(deps.clients, credentials.clientId, credentials.clientSecret)
  if (!client) {
    deps.logger.info('token denied', { client_id: credentials.clientId, reason: 'invalid_client' })
    return INVALID_CLIENT
  }
  const logger = deps.logger.child({ client_id: client.client_id, tenant_id: client.tenant_id })

  const grantType = req.body.grant_type
  if (typeof grantType !== 'string' || grantType === '') {
    return oauthError(400, 'invalid_request', 'grant_type is required')
  }
  if (grantType !== CLIENT_CREDENTIALS && grantType !== TOKEN_EXCHANGE) {
    return oauthError(400, 'unsupported_grant_type', `Unsupported grant_type ${grantType}`)
  }
  // LEARN: Each client may use only the grants it was registered for. Agents
  // cannot exchange tokens (or they could mint tokens for any target), and the
  // gateway cannot get tokens of its own, only tokens derived from a caller's.
  if (!client.allowed_grant_types.includes(grantType)) {
    logger.info('token denied', { reason: 'unauthorized_client', grant_type: grantType })
    return oauthError(400, 'unauthorized_client', 'This client may not use this grant type')
  }

  return grantType === TOKEN_EXCHANGE
    ? handleTokenExchange(deps, client, req.body, logger)
    : handleClientCredentials(deps, client, req.body, logger)
}

async function handleClientCredentials(
  deps: TokenHandlerDeps,
  client: OAuthClient,
  body: Record<string, unknown>,
  logger: Logger,
): Promise<HttpResult> {
  // Guaranteed by the clients file schema for client_credentials clients.
  if (!client.tenant_id) return oauthError(500, 'server_error', 'Client is misconfigured')

  const scopes = resolveScopes(body.scope, client.allowed_scopes)
  if (!scopes) {
    logger.info('token denied', { reason: 'invalid_scope', requested_scope: body.scope })
    return oauthError(400, 'invalid_scope', 'Requested scope exceeds the scopes allowed for this client')
  }

  const scope = scopes.join(' ')
  const issuedAt = Math.floor(Date.now() / 1000)
  const { token, jti } = await signAccessToken(deps, {
    audience: deps.audience,
    subject: client.client_id,
    tenantId: client.tenant_id,
    scope,
    issuedAt,
    expiresAt: issuedAt + deps.ttlSeconds,
  })

  logger.info('token issued', { jti, scope, expires_in: deps.ttlSeconds })
  return {
    status: 200,
    headers: NO_STORE,
    body: { access_token: token, token_type: 'Bearer', expires_in: deps.ttlSeconds, scope },
  }
}

async function authenticate(
  clients: ClientRegistry,
  clientId: string,
  clientSecret: string,
): Promise<OAuthClient | undefined> {
  const client = clients.findClient(clientId)
  const valid = await verifySecret(clientSecret, client?.secret_hash ?? DUMMY_HASH)
  return valid ? client : undefined
}

// RFC 6749 §2.3.1: id and secret are form-urlencoded before being joined with
// ":" and base64 encoded, so each part is decoded after the split.
function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? '')
  if (!match?.[1]) return undefined
  const decoded = Buffer.from(match[1], 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator <= 0) return undefined
  try {
    return {
      clientId: formDecode(decoded.slice(0, separator)),
      clientSecret: formDecode(decoded.slice(separator + 1)),
    }
  } catch {
    return undefined // malformed percent-encoding
  }
}

function formDecode(value: string): string {
  return decodeURIComponent(value.replaceAll('+', ' '))
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
