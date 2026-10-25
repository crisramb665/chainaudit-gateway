import { z } from 'zod'

const configSchema = z.object({
  ISSUER_PORT: z.coerce.number().int().positive().default(3002),
  // Becomes the `iss` claim; verifiers pin it, so it must not change casually.
  ISSUER_URL: z.url().default('http://localhost:3002'),
  TOKEN_AUDIENCE: z.string().min(1).default('chainaudit-gateway'),
  TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Tokens minted by token exchange for one hop live shorter than agent tokens.
  EXCHANGE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  ISSUER_KEY_FILE: z.string().min(1).default('.keys/token-issuer-es256.json'),
  CLIENTS_FILE: z.string().min(1).default('src/apps/token-issuer/clients.json'),
})

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env)
}
