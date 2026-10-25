// LEARN: This app plays a tenant's own MCP server, i.e. a third party from the
// platform's point of view. It knows nothing about our issuer or tokens: it
// only checks the API key the tenant registered with the gateway. This file
// is its composition root, wired the same way as the platform apps.
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { JsonLogger } from '../../adapters/local/json-logger.ts'
import { ApiKeyGuard } from './api-key-guard.ts'
import { ClientNotesServerFactory } from './client-notes-server-factory.ts'
import { parseConfig } from './config.ts'
import { NotesHttpHandler } from './notes-http-handler.ts'

const HOST = '127.0.0.1'

// 1. Configuration, read and validated once.
const config = parseConfig(process.env)

// 2. Collaborators, in dependency order.
const logger = new JsonLogger({ service: 'tenant-sample-server' })
const guard = new ApiKeyGuard(config.SAMPLE_API_KEY)
const factory = new ClientNotesServerFactory()
const handler = new NotesHttpHandler(guard, factory, logger)

// 3. HTTP routes. Stateless, like the platform servers.
const app = createMcpExpressApp({ host: HOST })
app.post('/mcp', (req, res) => handler.handle(req, res))
app.all('/mcp', (req, res) => handler.methodNotAllowed(req, res))

app.listen(config.SAMPLE_PORT, HOST, (err?: Error) => {
  if (err) {
    logger.error('tenant sample server failed to start', { err })
    process.exit(1)
  }
  logger.info('tenant sample server listening', { host: HOST, port: config.SAMPLE_PORT })
})
