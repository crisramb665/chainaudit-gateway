import { lookup } from 'node:dns/promises'
import type { DnsResolver } from '../../core/ports/dns-resolver.ts'

/** The operating system resolver (getaddrinfo), so /etc/hosts and `localhost` work as they do for curl. */
export class NodeDnsResolver implements DnsResolver {
  private readonly timeoutMs: number

  constructor(options: { timeoutMs: number }) {
    this.timeoutMs = options.timeoutMs
  }

  async resolve(hostname: string): Promise<string[]> {
    // dns.lookup has no timeout option and cannot be cancelled, so we stop
    // waiting instead: every outbound call has an explicit timeout.
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`DNS lookup timed out after ${this.timeoutMs} ms`)), this.timeoutMs)
    })
    try {
      const results = await Promise.race([lookup(hostname, { all: true, verbatim: true }), timeout])
      return [...new Set(results.map((r) => r.address))]
    } finally {
      clearTimeout(timer)
    }
  }
}
