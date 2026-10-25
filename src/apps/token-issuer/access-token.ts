import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { SIGNING_ALG, type SigningKey } from './signing-key.ts'

export interface AccessTokenClaims {
  audience: string
  subject: string
  tenantId: string
  scope: string
  /** Seconds since epoch. */
  issuedAt: number
  expiresAt: number
  /** RFC 8693 actor: the service acting on behalf of `subject`. */
  actor?: string
}

/** Signs an RFC 9068 JWT access token. Returns the token and its jti. */
export async function signAccessToken(
  key: { signingKey: SigningKey; issuer: string },
  claims: AccessTokenClaims,
): Promise<{ token: string; jti: string }> {
  const jti = randomUUID()
  const token = await new SignJWT({
    tenant_id: claims.tenantId,
    scope: claims.scope,
    ...(claims.actor ? { act: { sub: claims.actor } } : {}),
  })
    // typ at+jwt (RFC 9068) marks this as an access token, so a verifier can
    // refuse an ID token or any other JWT from the same issuer.
    .setProtectedHeader({ alg: SIGNING_ALG, kid: key.signingKey.kid, typ: 'at+jwt' })
    .setIssuer(key.issuer)
    // LEARN: The signature proves who issued the token, aud says who it is
    // for. Each receiver rejects tokens whose aud is not itself, so a token
    // minted for another service (or replayed by one) is useless there. That
    // is what blocks token passthrough and the confused deputy problem.
    .setAudience(claims.audience)
    .setSubject(claims.subject)
    .setIssuedAt(claims.issuedAt)
    // LEARN: A JWT is verified offline and cannot be revoked, so expiry is the
    // only kill switch. It bounds how long a leaked token works and how long a
    // scope change takes to apply; clients just ask for a new one.
    .setExpirationTime(claims.expiresAt)
    .setJti(jti)
    .sign(key.signingKey.privateKey)
  return { token, jti }
}
