import { InvalidTokenError, TokenVerifierUnavailableError } from '../../core/errors.ts'
import type { Principal, TokenVerifier } from '../../core/ports/token-verifier.ts'

export type AuthResult =
  | { ok: true; principal: Principal; token: string }
  | { ok: false; status: number; headers: Record<string, string>; body: unknown; reason: string }

export interface Authenticator {
  /** Authenticates an `Authorization: Bearer <jwt>` header value. */
  authenticate(authorization: string | undefined): Promise<AuthResult>
}

/** Bearer authentication shared by every service that receives tokens. */
export class BearerAuthenticator implements Authenticator {
  private readonly verifier: TokenVerifier
  private readonly resourceMetadataUrl: string | undefined

  constructor(verifier: TokenVerifier, resourceMetadataUrl?: string) {
    this.verifier = verifier
    this.resourceMetadataUrl = resourceMetadataUrl
  }

  async authenticate(authorization: string | undefined): Promise<AuthResult> {
    const metadata = this.resourceMetadataUrl ? `resource_metadata="${this.resourceMetadataUrl}"` : undefined
    const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization ?? '')?.[1]
    // LEARN: The 401 tells the client where to learn how to authenticate:
    // resource_metadata points to the RFC 9728 document, which names the
    // authorization server. That discovery step is what the MCP authorization
    // spec requires. Without credentials there is no error code (RFC 6750 §3.1).
    if (!token) {
      return unauthorized(['Bearer', metadata].filter(Boolean).join(' '), 'missing bearer token')
    }
    try {
      return { ok: true, principal: await this.verifier.verify(token), token }
    } catch (err) {
      if (err instanceof InvalidTokenError) {
        const params = [`error="invalid_token"`, `error_description="${err.message}"`, metadata].filter(Boolean)
        return unauthorized(`Bearer ${params.join(', ')}`, err.message)
      }
      if (err instanceof TokenVerifierUnavailableError) {
        return { ok: false, status: 503, headers: {}, body: { error: 'temporarily_unavailable' }, reason: err.message }
      }
      throw err
    }
  }
}

function unauthorized(wwwAuthenticate: string, reason: string): AuthResult {
  return {
    ok: false,
    status: 401,
    headers: { 'WWW-Authenticate': wwwAuthenticate },
    body: { error: 'invalid_token', error_description: reason },
    reason,
  }
}
