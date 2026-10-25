import { CircuitOpenError } from '../errors.ts'
import type { Clock } from '../ports/clock.ts'

export type BreakerState = 'closed' | 'open' | 'half_open'

export interface BreakerOptions {
  /** How many recent calls the failure rate is computed over. */
  windowSize: number
  /** Opens at or above this share of failures in a full window, e.g. 0.5. */
  failureRate: number
  /** How long the breaker stays open before letting one probe through. */
  openSeconds: number
}

export interface Transition {
  from: BreakerState
  to: BreakerState
  failures: number
  calls: number
}

/** A count-based circuit breaker: closed, open, half open. */
export class CircuitBreaker {
  private readonly clock: Clock
  private readonly options: BreakerOptions
  private state: BreakerState = 'closed'
  /** Last calls, true = failure. */
  private window: boolean[] = []
  private openedAt = 0
  private probing = false

  constructor(clock: Clock, options: BreakerOptions) {
    this.clock = clock
    this.options = options
  }

  async run<T>(fn: () => Promise<T>, isFailure: (err: unknown) => boolean, onTransition: (t: Transition) => void) {
    if (this.state === 'open' && this.clock.nowSeconds() - this.openedAt >= this.options.openSeconds) {
      // LEARN: open -> half open. After the cooldown the breaker does not close
      // blindly: it lets exactly one call through as a probe. If the target is
      // still broken, only that one call pays for it, not a burst of traffic.
      this.move('half_open', onTransition)
    }
    if (this.state === 'open' || (this.state === 'half_open' && this.probing)) throw new CircuitOpenError()

    const probe = this.state === 'half_open'
    this.probing = probe
    try {
      const result = await fn()
      this.record(false, probe, onTransition)
      return result
    } catch (err) {
      this.record(isFailure(err), probe, onTransition)
      throw err
    } finally {
      if (probe) this.probing = false
    }
  }

  private record(failed: boolean, probe: boolean, onTransition: (t: Transition) => void) {
    if (probe) {
      // LEARN: half open -> closed or open. The probe decides alone: success
      // means the target recovered, so the window starts clean; failure sends
      // the breaker back to open for another full cooldown, giving the target
      // more time instead of hammering it.
      if (failed) {
        this.openedAt = this.clock.nowSeconds()
        this.move('open', onTransition)
      } else {
        this.window = []
        this.move('closed', onTransition)
      }
      return
    }
    if (this.state !== 'closed') return
    this.window = [...this.window, failed].slice(-this.options.windowSize)
    const failures = this.window.filter(Boolean).length
    // LEARN: closed -> open. Only a full window counts, so one early failure is
    // not "100%". At 50% failures the target is clearly unhealthy: from now on
    // calls fail immediately, the caller gets a fast clear error instead of a
    // slow timeout, and the target gets room to recover.
    if (this.window.length === this.options.windowSize && failures / this.window.length >= this.options.failureRate) {
      this.openedAt = this.clock.nowSeconds()
      this.move('open', onTransition)
    }
  }

  private move(to: BreakerState, onTransition: (t: Transition) => void) {
    const from = this.state
    this.state = to
    onTransition({ from, to, failures: this.window.filter(Boolean).length, calls: this.window.length })
  }
}
