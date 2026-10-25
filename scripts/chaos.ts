// Breaks a Toxiproxy proxy on purpose, to watch the circuit breaker react.
//   pnpm chaos add <proxy> [latency_ms]   adds a latency toxic (default 3000 ms)
//   pnpm chaos remove <proxy>             removes it
//   pnpm chaos status                     lists proxies and their toxics
// Proxies: anvil (the chain provider), acme-notes (acme's tenant target).
// A script is its own tiny composition root: it reads and validates its input here, once.
import { z } from 'zod'

const TOXIC = 'chaos_latency'
const env = z.object({ TOXIPROXY_URL: z.url().default('http://localhost:8474') }).parse(process.env)
const [commandArg, proxyArg, latencyArg] = process.argv.slice(2)
const args = z
  .object({
    command: z.enum(['add', 'remove', 'status']),
    proxy: z.string().min(1).optional(),
    latency: z.coerce.number().int().positive().default(3000),
  })
  .refine((a) => a.command === 'status' || a.proxy !== undefined, 'a proxy name is required')
  .safeParse({ command: commandArg, proxy: proxyArg, latency: latencyArg })
if (!args.success) {
  console.error('Usage: pnpm chaos add <proxy> [latency_ms] | pnpm chaos remove <proxy> | pnpm chaos status')
  process.exit(1)
}

async function toxiproxy(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${env.TOXIPROXY_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(2000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Toxiproxy ${method} ${path}: HTTP ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}

const { command, proxy, latency } = args.data
if (command === 'add') {
  await toxiproxy('POST', `/proxies/${proxy}/toxics`, {
    name: TOXIC,
    type: 'latency',
    stream: 'downstream',
    attributes: { latency },
  })
  console.log(`${proxy}: +${latency} ms latency`)
} else if (command === 'remove') {
  await toxiproxy('DELETE', `/proxies/${proxy}/toxics/${TOXIC}`)
  console.log(`${proxy}: latency removed`)
} else {
  const proxies = (await toxiproxy('GET', '/proxies')) as Record<
    string,
    { listen: string; upstream: string; enabled: boolean; toxics: Array<{ name: string; attributes: unknown }> }
  >
  for (const [name, p] of Object.entries(proxies)) {
    const toxics = p.toxics.map((t) => `${t.name} ${JSON.stringify(t.attributes)}`).join(', ') || 'no toxics'
    console.log(`${name}: ${p.listen} -> ${p.upstream} (${p.enabled ? 'enabled' : 'disabled'}) ${toxics}`)
  }
}
