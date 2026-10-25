// A port for time, so expiry logic can be tested with a fixed clock instead
// of waiting or patching Date.now.
export interface Clock {
  /** Seconds since epoch. */
  nowSeconds(): number
}
