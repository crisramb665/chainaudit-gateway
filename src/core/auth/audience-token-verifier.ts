import type { JwtVerifier } from '../ports/jwt-verifier.ts'
import type { Principal, TokenVerifier } from '../ports/token-verifier.ts'

/** A TokenVerifier bound to one audience: the name of the service using it. */
export class AudienceTokenVerifier implements TokenVerifier {
  private readonly jwt: JwtVerifier
  private readonly audience: string

  constructor(jwt: JwtVerifier, audience: string) {
    this.jwt = jwt
    this.audience = audience
  }

  verify(token: string): Promise<Principal> {
    return this.jwt.verify(token, this.audience)
  }
}
