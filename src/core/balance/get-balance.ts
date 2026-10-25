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

export async function getBalance(
  deps: { balanceReader: BalanceReader },
  input: { address: HexAddress },
): Promise<BalanceResult> {
  const wei = await deps.balanceReader.getBalance(input.address)
  return { address: input.address, wei: wei.toString(), ether: formatEther(wei) }
}
