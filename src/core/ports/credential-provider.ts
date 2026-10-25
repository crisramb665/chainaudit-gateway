import type { Principal } from './token-verifier.ts'

/**
 * Tenant credentials for outbound calls. The caller is the verified Principal,
 * so the tenant always comes from a token, never from a request field.
 * Implementations refuse refs that belong to another tenant
 * (CredentialAccessDeniedError).
 */
export interface CredentialProvider {
  getSecret(caller: Principal, secretRef: string): Promise<string>
  putSecret(caller: Principal, secretRef: string, value: string): Promise<void>
}
