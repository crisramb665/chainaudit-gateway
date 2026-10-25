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

export interface AccessTokenSigner {
  /** Signs an RFC 9068 JWT access token. Returns the token and its jti. */
  sign(claims: AccessTokenClaims): Promise<{ token: string; jti: string }>
}
