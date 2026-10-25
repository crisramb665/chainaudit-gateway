import type { ExchangedToken, TokenExchanger, TokenExchangeRequest } from '../ports/token-exchanger.ts'

export interface CachingTokenExchanger {
  exchange(request: TokenExchangeRequest): Promise<ExchangedToken & { cache: 'hit' | 'miss' }>
}

export interface CacheOptions {
  /** Seconds before expiry at which a cached token stops being reused. */
  refreshMarginSeconds?: number
  maxEntries?: number
  now?: () => number
}

/** Reuses exchanged tokens until shortly before they expire. */
export function cachingTokenExchanger(inner: TokenExchanger, options: CacheOptions = {}): CachingTokenExchanger {
  // LEARN: The margin covers clock skew between hosts and the time a request
  // spends in flight. A token handed out with 2 s left could expire before
  // the target checks it, and the call would fail for no visible reason.
  const margin = options.refreshMarginSeconds ?? 30
  // LEARN: Every caller token creates new keys, so a cache without a bound
  // grows forever and becomes a memory leak (and a DoS lever). Expired entries
  // are swept and the oldest are dropped once the limit is reached.
  const maxEntries = options.maxEntries ?? 1000
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const entries = new Map<string, ExchangedToken>()

  return {
    async exchange(request) {
      // One token per caller token, audience and scope set: tokens are never
      // shared between callers, and a narrower request gets its own token.
      const key = [request.subjectTokenId, request.audience, [...request.scopes].sort().join(' ')].join('|')
      const cached = entries.get(key)
      if (cached && cached.expiresAt - margin > now()) return { ...cached, cache: 'hit' }

      const fresh = await inner.exchange(request)
      sweep()
      entries.delete(key)
      entries.set(key, fresh)
      return { ...fresh, cache: 'miss' }
    },
  }

  function sweep() {
    const t = now()
    for (const [key, token] of entries) if (token.expiresAt - margin <= t) entries.delete(key)
    // Map keeps insertion order, so the first keys are the oldest.
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }
}
