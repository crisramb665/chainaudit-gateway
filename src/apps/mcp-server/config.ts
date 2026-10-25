import { z } from 'zod'

const configSchema = z
  .object({
    MCP_PORT: z.coerce.number().int().positive().default(3001),
    // Through Toxiproxy, so failures can be injected without touching the app.
    RPC_URL: z.url().default('http://127.0.0.1:18545'),
    RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    ISSUER_URL: z.url().default('http://localhost:3002'),
    JWKS_URL: z.url().optional(),
    // Only tokens minted for this server (by token exchange) are accepted.
    TOKEN_AUDIENCE: z.string().min(1).default('chainaudit-mcp'),
  })
  .transform((c) => ({ ...c, JWKS_URL: c.JWKS_URL ?? `${c.ISSUER_URL}/.well-known/jwks.json` }))

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env)
}
