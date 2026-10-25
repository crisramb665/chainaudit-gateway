import { BaseError, TimeoutError, createPublicClient, http, type PublicClient } from 'viem'
import { ProviderTimeoutError, ProviderUnavailableError } from '../../core/errors.ts'
import type { BalanceReader, HexAddress } from '../../core/ports/balance-reader.ts'

export interface ViemBalanceReaderOptions {
  rpcUrl: string
  timeoutMs: number
}

export class ViemBalanceReader implements BalanceReader {
  private readonly client: PublicClient
  private readonly timeoutMs: number

  constructor(options: ViemBalanceReaderOptions) {
    this.timeoutMs = options.timeoutMs
    // The viem client is this adapter's implementation, not an injected dependency.
    this.client = createPublicClient({
      // LEARN: The timeout is explicit because viem's default is 10 s. A slow
      // provider is worse than a dead one: every waiting call holds a connection
      // and, on Lambda, a whole instance. 2 s fails fast and frees the capacity.
      // Retries are off (viem defaults to 3) so they cannot hide inside the
      // adapter. They will be added on purpose, with a budget and jitter, in the
      // resilience layer where they can be seen and tested.
      transport: http(options.rpcUrl, { timeout: options.timeoutMs, retryCount: 0 }),
    })
  }

  async getBalance(address: HexAddress): Promise<bigint> {
    try {
      return await this.client.getBalance({ address })
    } catch (err) {
      throw this.toDomainError(err)
    }
  }

  private toDomainError(err: unknown): unknown {
    if (!(err instanceof BaseError)) return err
    // viem wraps errors in layers; walk the cause chain to find the timeout.
    if (err.walk((e) => e instanceof TimeoutError)) {
      return new ProviderTimeoutError(this.timeoutMs, { cause: err })
    }
    return new ProviderUnavailableError({ cause: err })
  }
}
