import type { Clock } from '../ports/clock.ts'
import type { ExchangedToken, TokenExchanger, TokenExchangeRequest } from '../ports/token-exchanger.ts'

export interface CacheOptions {
  /** Seconds before expiry at which a cached token stops being reused. */
  refreshMarginSeconds: number
  maxEntries: number
}

// LEARN: A decorator. It implements the same port it wraps, so the gateway
// cannot tell whether it talks to the issuer or to the cache, and the cache
// can be added or removed in the composition root without touching callers.
/** Reuses exchanged tokens until shortly before they expire. */
export class CachingTokenExchanger implements TokenExchanger {
  private readonly inner: TokenExchanger
  private readonly clock: Clock
  private readonly options: CacheOptions
  private readonly entries = new Map<string, ExchangedToken>()

  constructor(inner: TokenExchanger, clock: Clock, options: CacheOptions) {
    this.inner = inner
    this.clock = clock
    // LEARN: The margin covers clock skew between hosts and the time a request
    // spends in flight. A token handed out with 2 s left could expire before
    // the target checks it, and the call would fail for no visible reason.
    // LEARN: Every caller token creates new keys, so a cache without a bound
    // grows forever and becomes a memory leak (and a DoS lever). Expired entries
    // are swept and the oldest are dropped once the limit is reached.
    this.options = options
  }

  async exchange(request: TokenExchangeRequest): Promise<ExchangedToken> {
    // One token per caller token, audience and scope set: tokens are never
    // shared between callers, and a narrower request gets its own token.
    const key = [request.subjectTokenId, request.audience, [...request.scopes].sort().join(' ')].join('|')
    const cached = this.entries.get(key)
    if (cached && this.isFresh(cached)) return { ...cached, cache: 'hit' }

    const fresh = await this.inner.exchange(request)
    this.sweep()
    this.entries.delete(key)
    this.entries.set(key, fresh)
    return { ...fresh, cache: 'miss' }
  }

  private isFresh(token: ExchangedToken): boolean {
    return token.expiresAt - this.options.refreshMarginSeconds > this.clock.nowSeconds()
  }

  private sweep() {
    for (const [key, token] of this.entries) if (!this.isFresh(token)) this.entries.delete(key)
    // Map keeps insertion order, so the first keys are the oldest.
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
