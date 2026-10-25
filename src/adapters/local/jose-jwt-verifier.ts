import {
  createLocalJWKSet,
  createRemoteJWKSet,
  errors,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose'
import { z } from 'zod'
import { InvalidTokenError, TokenVerifierUnavailableError } from '../../core/errors.ts'
import type { JwtVerifier } from '../../core/ports/jwt-verifier.ts'
import type { Principal } from '../../core/ports/token-verifier.ts'

const claimsSchema = z.object({
  sub: z.string().min(1),
  tenant_id: z.string().min(1),
  scope: z.string(),
  jti: z.string().min(1),
  exp: z.number(),
  act: z.object({ sub: z.string().min(1) }).optional(),
})

export interface JoseJwtVerifierOptions {
  issuer: string
  /** Seconds of clock skew accepted on exp/iat. */
  clockTolerance: number
}

/** Verifies ES256 JWT access tokens with jose against a key set. */
export class JoseJwtVerifier implements JwtVerifier {
  /** Keys fetched from an issuer's JWKS URL (gateway, MCP server). */
  static remoteKeys(jwksUrl: string): JWTVerifyGetKey {
    // LEARN: The key set is fetched once and cached, not fetched per request.
    // An unknown kid (the issuer rotated keys) triggers a refetch, but at most
    // once per cooldown, so a flood of tokens with made-up kids cannot turn the
    // gateway into a DoS amplifier against the issuer. The fetch has its own
    // timeout like every outbound call.
    return createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    })
  }

  /** Keys held in memory (the issuer verifying its own tokens). */
  static localKeys(jwks: JSONWebKeySet): JWTVerifyGetKey {
    return createLocalJWKSet(jwks)
  }

  private readonly keys: JWTVerifyGetKey
  private readonly options: JoseJwtVerifierOptions

  constructor(keys: JWTVerifyGetKey, options: JoseJwtVerifierOptions) {
    this.keys = keys
    this.options = options
  }

  async verify(token: string, audience: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.options.issuer,
        audience,
        // LEARN: Pinning the algorithm closes two classic attacks. `alg: none`
        // would mean "no signature". HS256 with the public key used as the
        // HMAC secret would let anyone who downloaded the JWKS mint tokens.
        // The token's header must never choose how it is verified.
        algorithms: ['ES256'],
        // LEARN: typ at+jwt (RFC 9068) rejects other JWTs from the same issuer,
        // such as ID tokens, that are validly signed but not access tokens.
        typ: 'at+jwt',
        requiredClaims: ['sub', 'exp', 'iat', 'jti', 'tenant_id', 'scope'],
        clockTolerance: this.options.clockTolerance,
      })
      const claims = claimsSchema.safeParse(payload)
      if (!claims.success) throw new InvalidTokenError('malformed claims')
      return {
        subject: claims.data.sub,
        tenantId: claims.data.tenant_id,
        scopes: claims.data.scope.split(' ').filter(Boolean),
        tokenId: claims.data.jti,
        expiresAt: claims.data.exp,
        ...(claims.data.act ? { actor: claims.data.act.sub } : {}),
      }
    } catch (err) {
      throw toDomainError(err)
    }
  }
}

function toDomainError(err: unknown): unknown {
  if (err instanceof InvalidTokenError) return err
  // Keys could not be fetched: our problem, not the caller's (503, not 401).
  if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError) || err.code === 'ERR_JOSE_GENERIC') {
    return new TokenVerifierUnavailableError({ cause: err })
  }
  if (err instanceof errors.JWTExpired) return new InvalidTokenError('token expired', { cause: err })
  if (err instanceof errors.JWTClaimValidationFailed) {
    const reason =
      err.claim === 'aud'
        ? 'unexpected audience'
        : err.claim === 'iss'
          ? 'unexpected issuer'
          : err.claim === 'typ'
            ? 'unexpected token type'
            : `invalid claim ${err.claim}`
    return new InvalidTokenError(reason, { cause: err })
  }
  if (err instanceof errors.JWSSignatureVerificationFailed)
    return new InvalidTokenError('invalid signature', { cause: err })
  if (err instanceof errors.JOSEAlgNotAllowed) return new InvalidTokenError('algorithm not allowed', { cause: err })
  if (err instanceof errors.JWKSNoMatchingKey) return new InvalidTokenError('unknown signing key', { cause: err })
  return new InvalidTokenError('malformed token', { cause: err })
}
