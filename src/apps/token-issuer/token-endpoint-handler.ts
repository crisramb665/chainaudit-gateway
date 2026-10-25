import type { TokenIssuer, TokenOutcome } from '../../core/issuer/token-issuer.ts'
import type { Logger } from '../../core/ports/logger.ts'
import { newTraceId, traceIdFrom } from '../shared/trace.ts'
import { NO_STORE, oauthError, type HttpResult } from './oauth-errors.ts'

/** The HTTP request as this handler needs it, independent of Express or Lambda. */
export interface TokenEndpointEvent {
  authorization: string | undefined
  traceparent: string | undefined
  body: Record<string, unknown>
}

// RFC 6749 §5.2 requires WWW-Authenticate on a 401 when Basic auth was used.
const BASIC_CHALLENGE = { 'WWW-Authenticate': 'Basic realm="chainaudit-token-issuer"' }

/**
 * POST /oauth2/token. HTTP concerns only: Basic credentials, status codes and
 * headers. The grant logic is the injected TokenIssuer.
 */
export class TokenEndpointHandler {
  private readonly issuer: TokenIssuer
  private readonly logger: Logger

  constructor(issuer: TokenIssuer, logger: Logger) {
    this.issuer = issuer
    this.logger = logger
  }

  async handle(event: TokenEndpointEvent): Promise<HttpResult> {
    const logger = this.logger.child({ trace_id: traceIdFrom(event.traceparent) ?? newTraceId() })
    const credentials = parseBasicAuth(event.authorization)
    if (!credentials) return oauthError(401, 'invalid_client', 'Client authentication failed', BASIC_CHALLENGE)
    try {
      return toHttp(await this.issuer.issue({ ...credentials, params: event.body }, logger))
    } catch (err) {
      logger.error('token request failed', { err })
      return oauthError(500, 'server_error', 'Unexpected error while issuing the token')
    }
  }
}

function toHttp(outcome: TokenOutcome): HttpResult {
  if (outcome.ok) return { status: 200, headers: NO_STORE, body: outcome.body }
  if (outcome.error === 'invalid_client') return oauthError(401, outcome.error, outcome.description, BASIC_CHALLENGE)
  return oauthError(outcome.error === 'server_error' ? 500 : 400, outcome.error, outcome.description)
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
