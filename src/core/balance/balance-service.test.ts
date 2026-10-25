// LEARN: DefaultBalanceService gets its BalanceReader through the constructor,
// typed by the port. So the test hands it a ten-line fake instead of viem and
// a running Anvil: no network, no Docker, no mocking library, and it runs in
// milliseconds. That is the practical payoff of constructor injection.
import { describe, expect, it } from 'vitest'
import { ProviderTimeoutError } from '../errors.ts'
import type { BalanceReader, HexAddress } from '../ports/balance-reader.ts'
import { DefaultBalanceService } from './balance-service.ts'

const ADDRESS: HexAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

class FakeBalanceReader implements BalanceReader {
  readonly calls: HexAddress[] = []
  private readonly result: bigint | Error

  constructor(result: bigint | Error) {
    this.result = result
  }

  async getBalance(address: HexAddress): Promise<bigint> {
    this.calls.push(address)
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

describe('DefaultBalanceService (mcp-server core)', () => {
  it('returns wei and ether as exact decimal strings', async () => {
    const reader = new FakeBalanceReader(1_234_500_000_000_000_000n)
    const service = new DefaultBalanceService(reader)

    await expect(service.getBalance(ADDRESS)).resolves.toEqual({
      address: ADDRESS,
      wei: '1234500000000000000',
      ether: '1.2345',
    })
    expect(reader.calls).toEqual([ADDRESS])
  })

  it('lets provider errors through so the tool can map them to isError', async () => {
    const service = new DefaultBalanceService(new FakeBalanceReader(new ProviderTimeoutError(2000)))

    await expect(service.getBalance(ADDRESS)).rejects.toBeInstanceOf(ProviderTimeoutError)
  })
})
