import { z } from 'zod'

const configSchema = z.object({
  MCP_PORT: z.coerce.number().int().positive().default(3001),
  // Through Toxiproxy, so failures can be injected without touching the app.
  RPC_URL: z.url().default('http://127.0.0.1:18545'),
  RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
})

export type Config = z.infer<typeof configSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse(env)
}
