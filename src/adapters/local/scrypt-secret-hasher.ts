import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import type { SecretVerifier } from '../../core/ports/secret-verifier.ts'

// LEARN: scrypt is deliberately slow and memory hard. Each guess against a
// stolen hash costs ~128 MiB of RAM, which makes GPU and ASIC brute force
// expensive. N=2^17, r=8, p=1 is the OWASP recommendation. The parameters are
// stored inside the hash string, so they can be raised later without
// invalidating existing secrets. The same cost applies to us on every login,
// which is why the token endpoint will need a rate limit.
const LOG2_N = 17
const R = 8
const P = 1
const SALT_BYTES = 16
const KEY_BYTES = 32

// Verified against when the client id is unknown, so that path costs the same
// scrypt work as a wrong secret. An all-zero hash that no secret produces.
const DUMMY_HASH = 'scrypt$17$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/** Hashes and verifies client secrets as `scrypt$<log2N>$<r>$<p>$<salt>$<hash>` with base64url parts. */
export class ScryptSecretHasher implements SecretVerifier {
  async hash(secret: string): Promise<string> {
    const salt = randomBytes(SALT_BYTES)
    const key = await derive(secret, salt, LOG2_N, R, P)
    return ['scrypt', LOG2_N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$')
  }

  async verify(secret: string, encodedHash: string | undefined): Promise<boolean> {
    const known = encodedHash !== undefined
    const [algorithm, log2N, r, p, salt, hash] = (encodedHash ?? DUMMY_HASH).split('$')
    if (algorithm !== 'scrypt' || !log2N || !r || !p || !salt || !hash) return false
    const expected = Buffer.from(hash, 'base64url')
    const actual = await derive(secret, Buffer.from(salt, 'base64url'), Number(log2N), Number(r), Number(p))
    // LEARN: `===` on strings stops at the first differing byte, so response
    // time leaks how much of a guess was right. timingSafeEqual always compares
    // every byte. It needs equal lengths, which a fixed key size guarantees.
    const matches = actual.length === expected.length && timingSafeEqual(actual, expected)
    return known && matches
  }
}

function derive(secret: string, salt: Buffer, log2N: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** log2N
  // Node's default maxmem (32 MiB) is below 128 * N * r, so raise it explicitly.
  const options: ScryptOptions = { N, r, p, maxmem: 256 * N * r }
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key)))
  })
}
