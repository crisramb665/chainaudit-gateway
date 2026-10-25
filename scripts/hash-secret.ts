// Prints an scrypt hash for a client secret, to paste into
// src/apps/token-issuer/clients.json. Usage: pnpm hash-secret <secret>
// A script is its own tiny composition root: it builds the adapter it needs.
import { ScryptSecretHasher } from '../src/adapters/local/scrypt-secret-hasher.ts'

const secret = process.argv[2]
if (!secret) {
  console.error('Usage: pnpm hash-secret <secret>')
  process.exit(1)
}
console.log(await new ScryptSecretHasher().hash(secret))
