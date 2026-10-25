import { z } from 'zod'

const configSchema = z
  .object({
    GATEWAY_PORT: z.coerce.number().int().positive().default(3000),
    // Public base URL; the protected resource is `${GATEWAY_URL}/mcp`.
    GATEWAY_URL: z.url().default('http://localhost:3000'),
    ISSUER_URL: z.url().default('http://localhost:3002'),
    JWKS_URL: z.url().optional(),
    TOKEN_AUDIENCE: z.string().min(1).default('chainaudit-gateway'),
    // Above the target's own 2 s provider timeout, so the target can report
    // that timeout as a clear tool error before the gateway gives up.
    TARGET_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    // The gateway's own client at the issuer, used for token exchange.
    GATEWAY_CLIENT_ID: z.string().min(1).default('chainaudit-gateway'),
    // Local development secret only. In any shared environment it comes from a secret store.
    GATEWAY_CLIENT_SECRET: z.string().min(1).default('gateway-local-secret'),
    TOKEN_ENDPOINT: z.url().optional(),
    EXCHANGE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
    // Tenant registry. An empty DYNAMODB_ENDPOINT means real AWS (default endpoint and credentials).
    DYNAMODB_ENDPOINT: z.string().default('http://localhost:8000'),
    AWS_REGION: z.string().min(1).default('us-east-1'),
    REGISTRY_TABLE: z.string().min(1).default('chainaudit-registry'),
    REGISTRY_CACHE_SECONDS: z.coerce.number().int().nonnegative().default(30),
    // Local stand-in for Secrets Manager.
    SECRETS_DIR: z.string().min(1).default('.secrets'),
  })
  .transform((c) => ({
    ...c,
    JWKS_URL: c.JWKS_URL ?? `${c.ISSUER_URL}/.well-known/jwks.json`,
    TOKEN_ENDPOINT: c.TOKEN_ENDPOINT ?? `${c.ISSUER_URL}/oauth2/token`,
  }))

export type Config = z.infer<typeof configSchema>

/** Validates the environment. Called once, from main.ts; nothing else reads environment variables. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse(env)
}
