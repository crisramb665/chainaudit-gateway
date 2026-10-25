import { InvalidTokenError, TokenVerifierUnavailableError } from '../../core/errors.ts'
import type { Principal, TokenVerifier } from '../../core/ports/token-verifier.ts'
import type { TargetConfig } from '../../core/gateway/targets.ts'

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: number; headers: Record<string, string>; body: unknown; reason: string }

/** Authenticates `Authorization: Bearer <jwt>`. A plain function, so it can run behind Express or in Lambda. */
export async function authenticate(
  authorization: string | undefined,
  verifier: TokenVerifier,
  resourceMetadataUrl: string,
): Promise<AuthResult> {
  const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization ?? '')?.[1]
  // LEARN: The 401 tells the client where to learn how to authenticate:
  // resource_metadata points to the RFC 9728 document, which names the
  // authorization server. That discovery step is what the MCP authorization
  // spec requires. Without credentials there is no error code (RFC 6750 §3.1).
  if (!token) {
    return unauthorized(`Bearer resource_metadata="${resourceMetadataUrl}"`, 'missing bearer token')
  }
  try {
    return { ok: true, principal: await verifier.verify(token) }
  } catch (err) {
    if (err instanceof InvalidTokenError) {
      return unauthorized(
        `Bearer error="invalid_token", error_description="${err.message}", resource_metadata="${resourceMetadataUrl}"`,
        err.message,
      )
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

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) for the gateway's /mcp endpoint. */
export function protectedResourceMetadata(resource: string, issuer: string, targets: TargetConfig[]) {
  const scopes = new Set(targets.flatMap((t) => Object.values(t.toolScopes)))
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...scopes].sort(),
    bearer_methods_supported: ['header'],
    resource_name: 'ChainAudit Gateway',
  }
}
