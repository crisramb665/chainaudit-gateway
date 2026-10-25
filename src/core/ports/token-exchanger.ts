export interface TokenExchangeRequest {
  /** The caller's verified token. Sent only to the issuer, never to a target. */
  subjectToken: string
  /** jti of the subject token, used as a cache key instead of the raw token. */
  subjectTokenId: string
  audience: string
  scopes: string[]
}

export interface ExchangedToken {
  accessToken: string
  /** Seconds since epoch. */
  expiresAt: number
}

// LEARN: A port, because this hop differs per environment. Locally it is RFC
// 8693 token exchange against our own issuer; in AWS the target credential
// may come from another mechanism. The gateway only needs "a token for this
// target with these scopes on behalf of this caller".
export interface TokenExchanger {
  /** Throws TokenExchangeError. */
  exchange(request: TokenExchangeRequest): Promise<ExchangedToken>
}
