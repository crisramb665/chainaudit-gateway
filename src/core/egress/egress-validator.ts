import type { DnsResolver } from '../ports/dns-resolver.ts'
import { classifyIp, isIpLiteralHost, type IpClass } from './ip-ranges.ts'

export type EgressResult = { ok: true; hostname: string; addresses: string[] } | { ok: false; reason: string }

/** Decides whether the gateway may call a tenant-supplied URL, and which IPs it may connect to. */
export interface EgressValidator {
  validate(url: string, allowedDomains: string[]): Promise<EgressResult>
}

export interface EgressOptions {
  /**
   * Local development only: also accept loopback and private addresses (and
   * plain http for them). Link-local, IPv4-mapped and reserved stay blocked.
   */
  allowPrivateNetworks: boolean
}

// LEARN: Server-side request forgery (SSRF). The gateway runs inside our
// network and calls URLs that tenants typed in. Without these checks a tenant
// could register http://169.254.169.254/ (cloud metadata, i.e. our
// credentials), an internal admin service, or a name that resolves to one,
// and use the gateway as a proxy into places only it can reach.
export class DefaultEgressValidator implements EgressValidator {
  private readonly resolver: DnsResolver
  private readonly options: EgressOptions

  constructor(resolver: DnsResolver, options: EgressOptions) {
    this.resolver = resolver
    this.options = options
  }

  async validate(rawUrl: string, allowedDomains: string[]): Promise<EgressResult> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return deny('base_url is not a valid URL')
    }
    if (url.username || url.password) return deny('base_url must not contain credentials')

    const plainHttp = url.protocol === 'http:'
    if (url.protocol !== 'https:' && !(plainHttp && this.options.allowPrivateNetworks)) {
      return deny('base_url must use https')
    }

    // LEARN: The WHATWG URL parser canonicalises every IPv4 spelling:
    // 2130706433, 0177.0.0.1 and 0x7f.0.0.1 all become 127.0.0.1. Those forms
    // exist because other parsers (inet_aton, some HTTP clients) accept them,
    // which is exactly why attackers use them to get past string filters such
    // as "starts with 127.". Checking the canonical hostname catches them all,
    // and a tenant has no reason to register a bare IP instead of a name.
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
    if (isIpLiteralHost(hostname)) return deny('base_url must use a hostname, not an IP address')

    if (!isAllowedDomain(hostname, allowedDomains)) {
      return deny(`host ${hostname} is not in the tenant's allowed domains`)
    }

    let addresses: string[]
    try {
      addresses = await this.resolver.resolve(hostname)
    } catch {
      return deny(`host ${hostname} could not be resolved`)
    }
    if (addresses.length === 0) return deny(`host ${hostname} did not resolve to any address`)

    // LEARN: Every address must pass, not just one. A name can return several
    // A/AAAA records and the HTTP client picks any of them (happy eyeballs,
    // round robin), so one private address among public ones is enough to
    // reach the internal network.
    for (const address of addresses) {
      const kind = classifyIp(address)
      if (!this.allowed(kind)) return deny(`host ${hostname} resolves to a ${kind} address (${address})`)
      if (plainHttp && kind === 'public') {
        return deny('base_url must use https (plain http is only accepted for local private addresses)')
      }
    }
    return { ok: true, hostname, addresses }
  }

  private allowed(kind: IpClass): boolean {
    if (kind === 'public') return true
    return this.options.allowPrivateNetworks && (kind === 'loopback' || kind === 'private')
  }
}

/** Exact match or a subdomain: api.example.com matches example.com, evilexample.com does not. */
function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains
    .map((d) => d.toLowerCase().replace(/\.$/, ''))
    .some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
}

function deny(reason: string): EgressResult {
  return { ok: false, reason }
}
