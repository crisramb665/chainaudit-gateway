/** Resolves a hostname to every address it has (A and AAAA). A port, so egress checks are testable without real DNS. */
export interface DnsResolver {
  /** Throws when the name cannot be resolved. */
  resolve(hostname: string): Promise<string[]>
}
