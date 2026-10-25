import { z } from 'zod'

const configSchema = z.object({
  SAMPLE_PORT: z.coerce.number().int().positive().default(3003),
  // The key the tenant hands to the platform when registering this server.
  SAMPLE_API_KEY: z.string().min(8).default('acme-sample-key'),
})

export type Config = z.infer<typeof configSchema>

/** Validates the environment. Called once, from main.ts; nothing else reads environment variables. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse(env)
}
