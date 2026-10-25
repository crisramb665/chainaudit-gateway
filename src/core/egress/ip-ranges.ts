/** What kind of address an IP is, from the point of view of outbound calls. */
export type IpClass = 'public' | 'loopback' | 'private' | 'link_local' | 'ipv4_mapped' | 'reserved'

type Range = { base: bigint; bits: number; width: 32 | 128; kind: IpClass }

// Most specific first: the first matching range wins.
const RANGES: Range[] = [
  // IPv4
  v4('127.0.0.0/8', 'loopback'),
  v4('10.0.0.0/8', 'private'),
  v4('172.16.0.0/12', 'private'),
  v4('192.168.0.0/16', 'private'),
  v4('100.64.0.0/10', 'private'), // carrier-grade NAT, shared address space
  v4('169.254.0.0/16', 'link_local'), // includes 169.254.169.254, the cloud metadata endpoint
  v4('0.0.0.0/8', 'reserved'),
  v4('192.0.0.0/24', 'reserved'),
  v4('192.0.2.0/24', 'reserved'),
  v4('198.18.0.0/15', 'reserved'),
  v4('198.51.100.0/24', 'reserved'),
  v4('203.0.113.0/24', 'reserved'),
  v4('224.0.0.0/4', 'reserved'), // multicast
  v4('240.0.0.0/4', 'reserved'), // includes 255.255.255.255
  // IPv6
  v6('::1/128', 'loopback'),
  v6('::/128', 'reserved'),
  // LEARN: An IPv4-mapped IPv6 address (::ffff:10.0.0.1) reaches the IPv4
  // host it wraps. A filter that only knows IPv4 ranges sees "some IPv6
  // address" and lets it through, so the whole block is refused outright.
  v6('::ffff:0:0/96', 'ipv4_mapped'),
  v6('::/96', 'reserved'), // deprecated IPv4-compatible
  v6('64:ff9b::/96', 'reserved'), // NAT64, can wrap any IPv4
  v6('100::/64', 'reserved'),
  v6('2001:db8::/32', 'reserved'),
  v6('2001::/32', 'reserved'), // Teredo, wraps IPv4
  v6('2002::/16', 'reserved'), // 6to4, can wrap private IPv4
  v6('fc00::/7', 'private'), // unique local
  v6('fe80::/10', 'link_local'),
  v6('fec0::/10', 'reserved'), // deprecated site-local
  v6('ff00::/8', 'reserved'), // multicast
]

/** Classifies a canonical IPv4 or IPv6 address. Anything unparseable is reserved (fail closed). */
export function classifyIp(ip: string): IpClass {
  const v4n = parseIPv4(ip)
  const parsed = v4n !== undefined ? { value: v4n, width: 32 as const } : parseIPv6WithWidth(ip)
  if (!parsed) return 'reserved'
  for (const range of RANGES) {
    if (range.width === parsed.width && inRange(parsed.value, range)) return range.kind
  }
  return 'public'
}

/** True when the URL host is an IP address rather than a name (after WHATWG URL canonicalisation). */
export function isIpLiteralHost(hostname: string): boolean {
  return hostname.startsWith('[') || parseIPv4(hostname) !== undefined || parseIPv6(hostname) !== undefined
}

/** Strict dotted-decimal IPv4 (the canonical form) to a number. */
export function parseIPv4(ip: string): bigint | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0n
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined
    const n = Number(part)
    if (n > 255) return undefined
    value = (value << 8n) | BigInt(n)
  }
  return value
}

/** IPv6 (with `::`, an optional embedded IPv4 tail and an optional %zone) to a 128-bit number. */
export function parseIPv6(input: string): bigint | undefined {
  const ip = input
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
  if (!ip.includes(':')) return undefined
  const halves = ip.split('::')
  if (halves.length > 2) return undefined
  const toGroups = (part: string): number[] | undefined => {
    if (part === '') return []
    const groups: number[] = []
    const pieces = part.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? ''
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4n = parseIPv4(piece)
        if (v4n === undefined) return undefined
        groups.push(Number(v4n >> 16n), Number(v4n & 0xffffn))
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
        groups.push(parseInt(piece, 16))
      }
    }
    return groups
  }
  const head = toGroups(halves[0] ?? '')
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : []
  if (!head || !tail) return undefined
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined
  const groups = [...head, ...new Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail]
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(g), 0n)
}

function parseIPv6WithWidth(ip: string): { value: bigint; width: 128 } | undefined {
  const value = parseIPv6(ip)
  return value === undefined ? undefined : { value, width: 128 }
}

function inRange(value: bigint, range: Range): boolean {
  const shift = BigInt(range.width - range.bits)
  return value >> shift === range.base >> shift
}

function v4(cidr: string, kind: IpClass): Range {
  const [ip, bits] = cidr.split('/')
  const base = parseIPv4(ip ?? '')
  if (base === undefined) throw new Error(`bad range ${cidr}`)
  return { base, bits: Number(bits), width: 32, kind }
}

function v6(cidr: string, kind: IpClass): Range {
  const [ip, bits] = cidr.split('/')
  const base = parseIPv6(ip ?? '')
  if (base === undefined) throw new Error(`bad range ${cidr}`)
  return { base, bits: Number(bits), width: 128, kind }
}
