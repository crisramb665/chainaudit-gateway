// LEARN: This file is the composition root of the MCP server: the one place
// that reads configuration, picks concrete adapters and wires the object graph
// in dependency order. Everything else receives its collaborators through the
// constructor, typed by interfaces, and never knows which implementation it
// got. Swapping viem for another provider, or the local verifier for an AWS
// one, is a change here only. Keeping wiring in one place also keeps the graph
// readable top to bottom, and makes every other class testable with fakes.
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { JoseJwtVerifier } from '../../adapters/local/jose-jwt-verifier.ts'
import { JsonLogger } from '../../adapters/local/json-logger.ts'
import { ViemBalanceReader } from '../../adapters/local/viem-balance-reader.ts'
import { AudienceTokenVerifier } from '../../core/auth/audience-token-verifier.ts'
import { DefaultBalanceService } from '../../core/balance/balance-service.ts'
import { BearerAuthenticator } from '../shared/bearer-auth.ts'
import { McpHttpHandler } from '../shared/mcp-http-handler.ts'
import { ChainToolsServerFactory } from './chain-tools-server-factory.ts'
import { parseConfig } from './config.ts'

const HOST = '127.0.0.1'

// 1. Configuration, read and validated once.
const config = parseConfig(process.env)

// 2. Adapters (driven side).
const logger = new JsonLogger({ service: 'mcp-server' })
// LEARN: Process-wide resources (the RPC client and its connection pool) are
// created once and shared. Only MCP protocol state is per request. Stateless
// is about the protocol, not about rebuilding everything on every call.
const balanceReader = new ViemBalanceReader({ rpcUrl: config.RPC_URL, timeoutMs: config.RPC_TIMEOUT_MS })
const jwtVerifier = new JoseJwtVerifier(JoseJwtVerifier.remoteKeys(config.JWKS_URL), {
  issuer: config.ISSUER_URL,
  clockTolerance: 5,
})

// 3. Core services.
const balances = new DefaultBalanceService(balanceReader)
// Only tokens minted for this server (by token exchange) are accepted.
const tokenVerifier = new AudienceTokenVerifier(jwtVerifier, config.TOKEN_AUDIENCE)

// 4. Driving side: authentication, per-request server factory, HTTP handler.
const authenticator = new BearerAuthenticator(tokenVerifier)
const serverFactory = new ChainToolsServerFactory(balances)
const mcpHandler = new McpHttpHandler(authenticator, serverFactory, logger, { traceMode: 'continue' })

// 5. HTTP routes. createMcpExpressApp parses JSON and, because HOST is
// loopback, rejects requests whose Host header is not localhost (DNS
// rebinding protection).
const app = createMcpExpressApp({ host: HOST })
app.post('/mcp', (req, res) => mcpHandler.handle(req, res))
app.all('/mcp', (req, res) => mcpHandler.methodNotAllowed(req, res))

app.listen(config.MCP_PORT, HOST, (err?: Error) => {
  if (err) {
    logger.error('mcp server failed to start', { err })
    process.exit(1)
  }
  logger.info('mcp server listening', {
    host: HOST,
    port: config.MCP_PORT,
    rpc_url: config.RPC_URL,
    audience: config.TOKEN_AUDIENCE,
  })
})
