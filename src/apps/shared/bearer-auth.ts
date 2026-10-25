import { InvalidTokenError, TokenVerifierUnavailableError } from '../../core/errors.ts'
import type { Principal, TokenVerifier } from '../../core/ports/token-verifier.ts'

export type AuthResult =
  | { ok: true; principal: Principal; token: string }
  | { ok: false; status: number; headers: Record<string, string>; body: unknown; reason: string }

/**
 * Authenticates `Authorization: Bearer <jwt>`. A plain function, so it can run
 * behind Express or in Lambda. Used by every service that receives tokens.
 */
export async function authenticate(
  authorization: string | undefined,
  verifier: TokenVerifier,
  resourceMetadataUrl?: string,
): Promise<AuthResult> {
  const metadata = resourceMetadataUrl ? `resource_metadata="${resourceMetadataUrl}"` : undefined
  const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization ?? '')?.[1]
  // LEARN: The 401 tells the client where to learn how to authenticate:
  // resource_metadata points to the RFC 9728 document, which names the
  // authorization server. That discovery step is what the MCP authorization
  // spec requires. Without credentials there is no error code (RFC 6750 §3.1).
  if (!token) {
    return unauthorized(['Bearer', metadata].filter(Boolean).join(' '), 'missing bearer token')
  }
  try {
    return { ok: true, principal: await verifier.verify(token), token }
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

function unauthorized(wwwAuthenticate: string, reason: string): AuthResult {
  return {
    ok: false,
    status: 401,
    headers: { 'WWW-Authenticate': wwwAuthenticate },
    body: { error: 'invalid_token', error_description: reason },
    reason,
  }
}
