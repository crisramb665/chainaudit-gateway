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
