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
