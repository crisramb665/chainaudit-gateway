import type { Clock } from '../ports/clock.ts'
import type { TenantTarget, TenantTargetReader } from '../ports/tenant-registry.ts'

export interface TargetCacheOptions {
  ttlSeconds: number
  /** Upper bound on cached tenants, so the cache cannot grow without limit. */
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
// used on the very next call.
/** Caches each tenant's active targets for a short TTL. */
export class CachingTenantTargetReader implements TenantTargetReader {
  private readonly inner: TenantTargetReader
  private readonly clock: Clock
  private readonly options: TargetCacheOptions
  private readonly entries = new Map<string, { targets: TenantTarget[]; fetchedAt: number }>()

  constructor(inner: TenantTargetReader, clock: Clock, options: TargetCacheOptions) {
    this.inner = inner
    this.clock = clock
    this.options = options
  }

  async listActiveTargets(tenantId: string): Promise<TenantTarget[]> {
    const now = this.clock.nowSeconds()
    const cached = this.entries.get(tenantId)
    if (cached && now - cached.fetchedAt < this.options.ttlSeconds) return cached.targets

    const targets = await this.inner.listActiveTargets(tenantId)
    this.entries.delete(tenantId)
    if (this.entries.size >= this.options.maxTenants) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(tenantId, { targets, fetchedAt: now })
    return targets
  }
}
