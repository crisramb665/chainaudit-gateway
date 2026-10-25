import { isTargetFailure } from '../errors.ts'
import type { Clock } from '../ports/clock.ts'
import type { Logger } from '../ports/logger.ts'
import { CircuitBreaker, type BreakerOptions } from './circuit-breaker.ts'

/** Runs a call to a target under that tenant's breaker for it. */
export interface TargetBreakers {
  /** Throws CircuitOpenError without calling `fn` while the circuit is open. */
  run<T>(tenantId: string, targetId: string, logger: Logger, fn: () => Promise<T>): Promise<T>
}

/** One breaker per tenant and target, so one tenant's broken target never trips anyone else's. */
export class CircuitBreakers implements TargetBreakers {
  private readonly clock: Clock
  private readonly options: BreakerOptions
  private readonly breakers = new Map<string, CircuitBreaker>()

  constructor(clock: Clock, options: BreakerOptions) {
    this.clock = clock
    this.options = options
  }

  run<T>(tenantId: string, targetId: string, logger: Logger, fn: () => Promise<T>): Promise<T> {
    const key = `${tenantId}|${targetId}`
    let breaker = this.breakers.get(key)
    if (!breaker) {
      breaker = new CircuitBreaker(this.clock, this.options)
      this.breakers.set(key, breaker)
    }
    return breaker.run(fn, isTargetFailure, (t) =>
      logger.warn('circuit breaker transition', { tenant_id: tenantId, target_id: targetId, ...t }),
    )
  }
}
