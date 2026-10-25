import type { BalanceReader, HexAddress } from '../ports/balance-reader.ts'
import { formatEther } from '../units.ts'

export interface BalanceResult {
  address: HexAddress
  // LEARN: Amounts are decimal strings, not JSON numbers. A JSON number is a
  // float64 with 53 bits of integer precision, about 0.009 ETH in wei, so any
  // real balance would be silently rounded by the agent's JSON parser.
  wei: string
  ether: string
}

/** What the MCP tools need from core. Handlers depend on this, not on the class. */
export interface BalanceService {
  /** Throws ProviderTimeoutError or ProviderUnavailableError. */
  getBalance(address: HexAddress): Promise<BalanceResult>
}

export class DefaultBalanceService implements BalanceService {
  private readonly reader: BalanceReader

  constructor(reader: BalanceReader) {
    this.reader = reader
  }

  async getBalance(address: HexAddress): Promise<BalanceResult> {
    const wei = await this.reader.getBalance(address)
    return { address, wei: wei.toString(), ether: formatEther(wei) }
  }
}
