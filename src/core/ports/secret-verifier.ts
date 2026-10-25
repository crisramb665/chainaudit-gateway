export interface SecretVerifier {
  /**
   * Checks `secret` against a stored hash. `encodedHash` is undefined when the
   * client is unknown; implementations must still spend the same work, so the
   * response time does not reveal which client ids exist.
   */
  verify(secret: string, encodedHash: string | undefined): Promise<boolean>
}
