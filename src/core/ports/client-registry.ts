export const CLIENT_CREDENTIALS = 'client_credentials'
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'

export type GrantType = typeof CLIENT_CREDENTIALS | typeof TOKEN_EXCHANGE

/** An OAuth client registered at the issuer. */
export interface OAuthClient {
  client_id: string
  // Agents belong to one tenant. The gateway has none: it acts for many.
  tenant_id?: string
  allowed_grant_types: GrantType[]
  allowed_scopes: string[]
  /** Token exchange only: the aud a subject token must have for this client to exchange it. */
  subject_audience?: string
  /** Token exchange only: the audiences this client may request. */
  allowed_audiences?: string[]
  secret_hash: string
}

export interface ClientRegistry {
  findClient(clientId: string): OAuthClient | undefined
}
