// LEARN: Dependency inversion. Core declares the interface it needs and the
// adapters (viem today, maybe a provider SDK later) implement it. Core never
// imports an RPC library, so swapping the node provider or faking it in a test
// touches no business code.
export type HexAddress = `0x${string}`

export interface BalanceReader {
  /** Balance in wei. Throws ProviderTimeoutError or ProviderUnavailableError. */
  getBalance(address: HexAddress): Promise<bigint>
}
