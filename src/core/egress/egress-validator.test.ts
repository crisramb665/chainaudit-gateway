// LEARN: The validator depends on a DnsResolver port, so a ten-line fake can
// make any name resolve to any address. That is the only way to test DNS
// rebinding, metadata IPs or mixed public/private answers deterministically:
// real DNS cannot be told to lie on cue.
import { describe, expect, it } from 'vitest'
import type { DnsResolver } from '../ports/dns-resolver.ts'
import { DefaultEgressValidator } from './egress-validator.ts'

class FakeResolver implements DnsResolver {
  readonly records: Record<string, string[]>

  constructor(records: Record<string, string[]>) {
    this.records = records
  }

  async resolve(hostname: string): Promise<string[]> {
    const addresses = this.records[hostname]
    if (!addresses) throw new Error('ENOTFOUND')
    return addresses
  }
}

const PUBLIC = '93.184.216.34'
const ALLOWED = ['example.com', 'localhost']

function validator(records: Record<string, string[]>, allowPrivateNetworks = false) {
  return new DefaultEgressValidator(new FakeResolver(records), { allowPrivateNetworks })
}

describe('DefaultEgressValidator (gateway core)', () => {
  it('accepts https on an allowed domain that resolves only to public addresses', async () => {
    const result = await validator({ 'api.example.com': [PUBLIC, '2606:2800:220:1::1'] }).validate(
      'https://api.example.com/mcp',
      ALLOWED,
    )
    expect(result).toEqual({ ok: true, hostname: 'api.example.com', addresses: [PUBLIC, '2606:2800:220:1::1'] })
  })

  it.each([
    ['http://example.com/mcp', 'base_url must use https'],
    ['ftp://example.com/mcp', 'base_url must use https'],
    ['https://user:pass@example.com/mcp', 'base_url must not contain credentials'],
    ['not a url', 'base_url is not a valid URL'],
  ])('refuses %s', async (url, reason) => {
    expect(await validator({ 'example.com': [PUBLIC] }).validate(url, ALLOWED)).toEqual({ ok: false, reason })
  })

  it.each([
    'https://127.0.0.1/mcp',
    'https://2130706433/mcp', // decimal
    'https://0177.0.0.1/mcp', // octal
    'https://0x7f.0.0.1/mcp', // hex
    'https://0x7f000001/mcp', // single hex number
    'https://[::1]/mcp',
    'https://[::ffff:169.254.169.254]/mcp',
    'https://169.254.169.254/latest/meta-data/',
  ])('refuses an IP written instead of a hostname: %s', async (url) => {
    expect(await validator({}).validate(url, ALLOWED)).toEqual({
      ok: false,
      reason: 'base_url must use a hostname, not an IP address',
    })
  })

  it('refuses hosts outside the allowed domains, including look-alike suffixes', async () => {
    const v = validator({ 'evilexample.com': [PUBLIC], 'example.org': [PUBLIC] })
    expect(await v.validate('https://evilexample.com/mcp', ALLOWED)).toMatchObject({ ok: false })
    expect(await v.validate('https://example.org/mcp', ALLOWED)).toEqual({
      ok: false,
      reason: "host example.org is not in the tenant's allowed domains",
    })
  })

  it.each([
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link_local'],
    ['fd00::1', 'private'],
    ['fe80::1', 'link_local'],
    ['::1', 'loopback'],
    ['::ffff:10.0.0.1', 'ipv4_mapped'],
    ['::ffff:8.8.8.8', 'ipv4_mapped'],
    ['0.0.0.0', 'reserved'],
  ])('refuses a name that resolves to %s (%s)', async (address, kind) => {
    expect(await validator({ 'api.example.com': [address] }).validate('https://api.example.com/mcp', ALLOWED)).toEqual({
      ok: false,
      reason: `host api.example.com resolves to a ${kind} address (${address})`,
    })
  })

  it('refuses a name that resolves to one public and one private address', async () => {
    const result = await validator({ 'api.example.com': [PUBLIC, '10.1.2.3'] }).validate(
      'https://api.example.com/mcp',
      ALLOWED,
    )
    expect(result).toEqual({ ok: false, reason: 'host api.example.com resolves to a private address (10.1.2.3)' })
  })

  it('refuses names that do not resolve or resolve to nothing', async () => {
    const v = validator({ 'empty.example.com': [] })
    expect(await v.validate('https://missing.example.com/mcp', ALLOWED)).toMatchObject({ ok: false })
    expect(await v.validate('https://empty.example.com/mcp', ALLOWED)).toMatchObject({ ok: false })
  })

  describe('local mode (allowPrivateNetworks)', () => {
    const local = validator({ localhost: ['127.0.0.1', '::1'], 'meta.localhost': ['169.254.169.254'] }, true)

    it('accepts localhost over http, and returns its loopback addresses to pin', async () => {
      expect(await local.validate('http://localhost:3003/mcp', ALLOWED)).toEqual({
        ok: true,
        hostname: 'localhost',
        addresses: ['127.0.0.1', '::1'],
      })
    })

    it('still refuses metadata, IPv4-mapped and IP literals', async () => {
      expect(await local.validate('http://meta.localhost/mcp', ALLOWED)).toMatchObject({ ok: false })
      expect(
        await validator({ 'm.example.com': ['::ffff:127.0.0.1'] }, true).validate('https://m.example.com/', ALLOWED),
      ).toMatchObject({ ok: false })
      expect(await local.validate('http://127.0.0.1:3003/mcp', ALLOWED)).toMatchObject({ ok: false })
    })

    it('does not allow plain http to a public address', async () => {
      expect(await validator({ 'example.com': [PUBLIC] }, true).validate('http://example.com/', ALLOWED)).toMatchObject(
        { ok: false },
      )
    })
  })
})
