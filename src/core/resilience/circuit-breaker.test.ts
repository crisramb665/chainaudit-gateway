import { describe, expect, it } from 'vitest'
import { CircuitOpenError, TargetCallError, isTargetFailure } from '../errors.ts'
import type { Clock } from '../ports/clock.ts'
import { CircuitBreaker, type Transition } from './circuit-breaker.ts'

class FakeClock implements Clock {
  now = 1_000

  nowSeconds(): number {
    return this.now
  }
}

const timeout = () => Promise.reject(new TargetCallError('timeout', 'timed out'))
const unauthorized = () => Promise.reject(new TargetCallError('http_4xx', 'rejected the credentials (HTTP 401)'))
const ok = () => Promise.resolve('ok')

function build() {
  const clock = new FakeClock()
  const breaker = new CircuitBreaker(clock, { windowSize: 10, failureRate: 0.5, openSeconds: 15 })
  const transitions: Array<Pick<Transition, 'from' | 'to'>> = []
  const run = (fn: () => Promise<string>) =>
    breaker.run(fn, isTargetFailure, ({ from, to }) => transitions.push({ from, to })).catch((e: unknown) => e)
  return { clock, run, transitions }
}

async function times(n: number, fn: () => Promise<unknown>) {
  for (let i = 0; i < n; i++) await fn()
}

describe('CircuitBreaker', () => {
  it('stays closed at 4 failures in 10 and opens at 5', async () => {
    const { run, transitions } = build()
    await times(6, () => run(ok))
    await times(4, () => run(timeout))
    expect(transitions).toEqual([])

    await run(timeout) // window is now 5 ok + 5 failures
    expect(transitions).toEqual([{ from: 'closed', to: 'open' }])
  })

  it('needs a full window: early failures alone do not open it', async () => {
    const { run, transitions } = build()
    await times(9, () => run(timeout))
    expect(transitions).toEqual([])
    await run(timeout)
    expect(transitions).toEqual([{ from: 'closed', to: 'open' }])
  })

  it('rejects immediately while open, without calling the target', async () => {
    const { run } = build()
    await times(10, () => run(timeout))
    let called = false
    const result = await run(async () => {
      called = true
      return 'ok'
    })
    expect(result).toBeInstanceOf(CircuitOpenError)
    expect(called).toBe(false)
  })

  it('after 15 s lets exactly one probe through; success closes it', async () => {
    const { clock, run, transitions } = build()
    await times(10, () => run(timeout))
    clock.now += 14
    expect(await run(ok)).toBeInstanceOf(CircuitOpenError)

    clock.now += 1
    let release: (v: string) => void = () => {}
    const probe = run(() => new Promise<string>((resolve) => (release = resolve)))
    expect(await run(ok)).toBeInstanceOf(CircuitOpenError) // second call while the probe is in flight
    release('ok')
    expect(await probe).toBe('ok')

    expect(transitions).toEqual([
      { from: 'closed', to: 'open' },
      { from: 'open', to: 'half_open' },
      { from: 'half_open', to: 'closed' },
    ])
    expect(await run(ok)).toBe('ok')
  })

  it('a failed probe reopens it for another 15 s', async () => {
    const { clock, run, transitions } = build()
    await times(10, () => run(timeout))
    clock.now += 15
    await run(timeout)
    expect(transitions.at(-1)).toEqual({ from: 'half_open', to: 'open' })

    clock.now += 14
    expect(await run(ok)).toBeInstanceOf(CircuitOpenError)
    clock.now += 1
    expect(await run(ok)).toBe('ok')
  })

  it('does not count 4xx: the target answered', async () => {
    const { run, transitions } = build()
    await times(10, () => run(unauthorized))
    expect(transitions).toEqual([])
  })
})
