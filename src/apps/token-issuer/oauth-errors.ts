export interface HttpResult {
  status: number
  headers: Record<string, string>
  body: unknown
}

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'server_error'

// LEARN: Token responses, including errors, can carry credentials, so RFC 6749
// §5.1 requires that no cache (browser, proxy, CDN) ever stores them.
export const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' }

/** Error response in the RFC 6749 §5.2 format. */
export function oauthError(
  status: number,
  error: OAuthErrorCode,
  description: string,
  headers: Record<string, string> = {},
): HttpResult {
  return { status, headers: { ...NO_STORE, ...headers }, body: { error, error_description: description } }
}
