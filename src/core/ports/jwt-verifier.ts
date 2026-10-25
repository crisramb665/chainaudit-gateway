import type { Principal } from './token-verifier.ts'

/**
 * Verifies a JWT access token for an audience chosen per call. The issuer
 * needs this because the expected audience of a subject token depends on the
 * client exchanging it. Services with one fixed audience use TokenVerifier.
 */
export interface JwtVerifier {
  /** Throws InvalidTokenError or TokenVerifierUnavailableError. */
  verify(token: string, audience: string): Promise<Principal>
}
