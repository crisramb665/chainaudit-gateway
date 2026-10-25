import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import type { AccessTokenClaims, AccessTokenSigner } from '../../core/ports/access-token-signer.ts'
import { SIGNING_ALG, type SigningKey } from './file-signing-key-store.ts'

export class JoseAccessTokenSigner implements AccessTokenSigner {
  private readonly key: SigningKey
  private readonly issuer: string

  constructor(key: SigningKey, issuer: string) {
    this.key = key
    this.issuer = issuer
  }

  async sign(claims: AccessTokenClaims): Promise<{ token: string; jti: string }> {
    const jti = randomUUID()
    const token = await new SignJWT({
      tenant_id: claims.tenantId,
      scope: claims.scope,
      ...(claims.actor ? { act: { sub: claims.actor } } : {}),
    })
      // typ at+jwt (RFC 9068) marks this as an access token, so a verifier can
      // refuse an ID token or any other JWT from the same issuer.
      .setProtectedHeader({ alg: SIGNING_ALG, kid: this.key.kid, typ: 'at+jwt' })
      .setIssuer(this.issuer)
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
      .sign(this.key.privateKey)
    return { token, jti }
  }
}
