import type { Clock } from '../ports/clock.ts'
import type { TenantSettings, TenantTarget, TenantTargetReader } from '../ports/tenant-registry.ts'

export interface TargetCacheOptions {
  ttlSeconds: number
  /** Upper bound on cached tenants per map, so the cache cannot grow without limit. */
  maxTenants: number
}

// LEARN: The staleness trade-off. Routing reads a tenant's targets on almost
// every request; caching them for 30 seconds removes that DynamoDB call from
// the hot path. The price: a target disabled or deleted in the registry stays
// callable for up to 30 s on every gateway instance, and a newly activated
// one appears up to 30 s late. There is no cross-instance invalidation (each
// Lambda has its own cache), so the TTL is the only bound. For a kill switch
// that must act immediately, the TTL would have to drop or the check move to
// the call path. Credentials are deliberately not cached, so a rotated key is
// used on the very next call, and neither is DNS: egress checks resolve fresh.
/** Caches each tenant's active targets and settings for a short TTL. */
export class CachingTenantTargetReader implements TenantTargetReader {
  private readonly inner: TenantTargetReader
  private readonly targets: TtlCache<TenantTarget[]>
  private readonly settings: TtlCache<TenantSettings | undefined>

  constructor(inner: TenantTargetReader, clock: Clock, options: TargetCacheOptions) {
    this.inner = inner
    this.targets = new TtlCache(clock, options)
    this.settings = new TtlCache(clock, options)
  }

  listActiveTargets(tenantId: string): Promise<TenantTarget[]> {
    return this.targets.get(tenantId, () => this.inner.listActiveTargets(tenantId))
  }

  getTenantSettings(tenantId: string): Promise<TenantSettings | undefined> {
    return this.settings.get(tenantId, () => this.inner.getTenantSettings(tenantId))
  }
}

class TtlCache<T> {
  private readonly clock: Clock
  private readonly options: TargetCacheOptions
  private readonly entries = new Map<string, { value: T; fetchedAt: number }>()

  constructor(clock: Clock, options: TargetCacheOptions) {
    this.clock = clock
    this.options = options
  }

  async get(key: string, load: () => Promise<T>): Promise<T> {
    const now = this.clock.nowSeconds()
    const cached = this.entries.get(key)
    if (cached && now - cached.fetchedAt < this.options.ttlSeconds) return cached.value

    const value = await load()
    this.entries.delete(key)
    if (this.entries.size >= this.options.maxTenants) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { value, fetchedAt: now })
    return value
  }
}
