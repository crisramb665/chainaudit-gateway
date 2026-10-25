import type { Clock } from '../../core/ports/clock.ts'

export class SystemClock implements Clock {
  nowSeconds(): number {
    return Math.floor(Date.now() / 1000)
  }
}
