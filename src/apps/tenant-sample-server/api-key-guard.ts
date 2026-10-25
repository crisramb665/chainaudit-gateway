import { createHash, timingSafeEqual } from 'node:crypto'
import type { KeyGuard } from './notes-http-handler.ts'

/** Checks the X-Api-Key header the platform sends on behalf of the tenant. */
export class ApiKeyGuard implements KeyGuard {
  private readonly expectedDigest: Buffer

  constructor(apiKey: string) {
    this.expectedDigest = digest(apiKey)
  }

  // LEARN: Comparing SHA-256 digests in constant time. Hashing first gives
  // both sides the same length (timingSafeEqual requires it) without leaking
  // the key's length, and timingSafeEqual does not stop at the first
  // mismatching byte, so response time reveals nothing about the key.
  allows(presented: string | undefined): boolean {
    return presented !== undefined && timingSafeEqual(digest(presented), this.expectedDigest)
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}
