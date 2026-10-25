const ETHER_DECIMALS = 18

/** Formats an integer amount of the smallest unit as a decimal string. */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const fraction = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}

export function formatEther(wei: bigint): string {
  return formatUnits(wei, ETHER_DECIMALS)
}
