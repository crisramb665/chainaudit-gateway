import { randomBytes } from 'node:crypto'

const TRACEPARENT = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/

/** The trace id of a W3C traceparent header (00-<trace>-<span>-<flags>), if valid. */
export function traceIdFrom(traceparent: string | undefined): string | undefined {
  return TRACEPARENT.exec(traceparent ?? '')?.[1]
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex')
}

/** A traceparent for an outgoing call: same trace, new span. */
export function traceparentFor(traceId: string): string {
  return `00-${traceId}-${randomBytes(8).toString('hex')}-01`
}
