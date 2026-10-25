/** Who is calling, taken only from a verified token. */
export interface Principal {
  /** The client the token was issued to (`sub`). */
  subject: string
  // LEARN: tenant_id lives here and nowhere else. Code that needs the tenant
  // reads it from the Principal, never from tool arguments or request bodies,
  // so a caller cannot act for another tenant by editing a JSON field.
  tenantId: string
  scopes: string[]
  tokenId: string
  /** Seconds since epoch. */
  expiresAt: number
}

export interface TokenVerifier {
  /** Throws InvalidTokenError or TokenVerifierUnavailableError. */
  verify(token: string): Promise<Principal>
}
