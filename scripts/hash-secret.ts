// Prints an scrypt hash for a client secret, to paste into
// src/apps/token-issuer/clients.json. Usage: pnpm hash-secret <secret>
import { hashSecret } from '../src/apps/token-issuer/secret-hash.ts'

const secret = process.argv[2]
if (!secret) {
  console.error('Usage: pnpm hash-secret <secret>')
  process.exit(1)
}
console.log(await hashSecret(secret))
