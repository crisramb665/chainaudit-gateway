// LEARN: Domain errors carry a message that is safe to show to the agent.
// The raw provider error travels only in `cause`, which gets logged but is
// never returned, so internal URLs or stack traces cannot leak to callers.
export class DomainError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

export class ProviderTimeoutError extends DomainError {
  constructor(timeoutMs: number, options?: ErrorOptions) {
    super('PROVIDER_TIMEOUT', `Node provider timed out after ${timeoutMs} ms`, options)
  }
}

export class ProviderUnavailableError extends DomainError {
  constructor(options?: ErrorOptions) {
    super('PROVIDER_UNAVAILABLE', 'Node provider unavailable', options)
  }
}

/** The bearer token was rejected. `reason` is safe to return to the caller. */
export class InvalidTokenError extends DomainError {
  constructor(reason: string, options?: ErrorOptions) {
    super('INVALID_TOKEN', reason, options)
  }
}

/** The token could not be checked at all (e.g. issuer keys unreachable). */
export class TokenVerifierUnavailableError extends DomainError {
  constructor(options?: ErrorOptions) {
    super('TOKEN_VERIFIER_UNAVAILABLE', 'Token verification is temporarily unavailable', options)
  }
}

/** A token for the next hop could not be obtained. */
export class TokenExchangeError extends DomainError {
  constructor(options?: ErrorOptions) {
    super('TOKEN_EXCHANGE_FAILED', 'Could not obtain a token for the target', options)
  }
}

export type TargetFailureKind = 'timeout' | 'connection' | 'http_5xx' | 'http_4xx' | 'protocol'

/** A call to a target failed. `reason` is coarse and safe (no URLs, no stack). */
export class TargetCallError extends DomainError {
  readonly kind: TargetFailureKind

  constructor(kind: TargetFailureKind, reason: string, options?: ErrorOptions) {
    super('TARGET_CALL_FAILED', reason, options)
    this.kind = kind
  }
}

/** Failures that say the target is unhealthy. A 4xx or protocol error means it answered. */
export function isTargetFailure(err: unknown): boolean {
  return (
    err instanceof TargetCallError && (err.kind === 'timeout' || err.kind === 'connection' || err.kind === 'http_5xx')
  )
}

/** The circuit for this tenant and target is open: the call was not attempted. */
export class CircuitOpenError extends DomainError {
  constructor() {
    super('CIRCUIT_OPEN', 'Circuit open')
  }
}

/** A credential was requested for a tenant other than the caller's. */
export class CredentialAccessDeniedError extends DomainError {
  constructor(options?: ErrorOptions) {
    super('CREDENTIAL_ACCESS_DENIED', 'Credential belongs to another tenant', options)
  }
}
