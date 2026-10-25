import { BaseError, TimeoutError, createPublicClient, http } from 'viem'
import { ProviderTimeoutError, ProviderUnavailableError } from '../../core/errors.ts'
import type { BalanceReader } from '../../core/ports/balance-reader.ts'

export function createViemBalanceReader(options: { rpcUrl: string; timeoutMs: number }): BalanceReader {
  const client = createPublicClient({
    // LEARN: The timeout is explicit because viem's default is 10 s. A slow
    // provider is worse than a dead one: every waiting call holds a connection
    // and, on Lambda, a whole instance. 2 s fails fast and frees the capacity.
    // Retries are off (viem defaults to 3) so they cannot hide inside the
    // adapter. They will be added on purpose, with a budget and jitter, in the
    // resilience layer where they can be seen and tested.
    transport: http(options.rpcUrl, { timeout: options.timeoutMs, retryCount: 0 }),
  })

  return {
    async getBalance(address) {
      try {
        return await client.getBalance({ address })
      } catch (err) {
        throw toDomainError(err, options.timeoutMs)
      }
    },
  }
}

function toDomainError(err: unknown, timeoutMs: number): unknown {
  if (!(err instanceof BaseError)) return err
  // viem wraps errors in layers; walk the cause chain to find the timeout.
  if (err.walk((e) => e instanceof TimeoutError)) {
    return new ProviderTimeoutError(timeoutMs, { cause: err })
  }
  return new ProviderUnavailableError({ cause: err })
}
