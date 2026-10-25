// LEARN: This file is the composition root of the gateway: the one place that
// reads configuration, picks concrete adapters and wires the object graph in
// dependency order. Everything else receives its collaborators through the
// constructor, typed by interfaces, and never knows which implementation it
// got. Moving to AWS (another token verifier, a registry instead of static
// targets) changes lines here, not the gateway's logic. Keeping wiring in one
// place also keeps the graph readable top to bottom, and makes every other
// class testable with fakes.
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { JoseJwtVerifier } from '../../adapters/local/jose-jwt-verifier.ts'
import { JsonLogger } from '../../adapters/local/json-logger.ts'
import { McpTargetClient } from '../../adapters/local/mcp-target-client.ts'
import { OAuthTokenExchanger } from '../../adapters/local/oauth-token-exchanger.ts'
import { SystemClock } from '../../adapters/local/system-clock.ts'
import { AudienceTokenVerifier } from '../../core/auth/audience-token-verifier.ts'
import { CachingTokenExchanger } from '../../core/auth/caching-token-exchanger.ts'
import { DefaultGatewayService } from '../../core/gateway/gateway-service.ts'
import { BearerAuthenticator } from '../shared/bearer-auth.ts'
import { McpHttpHandler } from '../shared/mcp-http-handler.ts'
import { parseConfig } from './config.ts'
import { GatewayServerFactory } from './gateway-server-factory.ts'
import { ProtectedResourceHandler, protectedResourceMetadata } from './resource-metadata.ts'
import { STATIC_TARGETS } from './targets.ts'

const HOST = '127.0.0.1'

// 1. Configuration, read and validated once.
const config = parseConfig(process.env)
const resource = `${config.GATEWAY_URL}/mcp`
// RFC 9728 §3.1: the well-known segment goes between host and resource path.
const resourceMetadataUrl = `${config.GATEWAY_URL}/.well-known/oauth-protected-resource/mcp`

// 2. Adapters (driven side).
const logger = new JsonLogger({ service: 'gateway' })
const clock = new SystemClock()
const jwtVerifier = new JoseJwtVerifier(JoseJwtVerifier.remoteKeys(config.JWKS_URL), {
  issuer: config.ISSUER_URL,
  clockTolerance: 5,
})
const issuerExchanger = new OAuthTokenExchanger(
  {
    tokenEndpoint: config.TOKEN_ENDPOINT,
    clientId: config.GATEWAY_CLIENT_ID,
    clientSecret: config.GATEWAY_CLIENT_SECRET,
    timeoutMs: config.EXCHANGE_TIMEOUT_MS,
  },
  clock,
)
const targetClient = new McpTargetClient({ timeoutMs: config.TARGET_TIMEOUT_MS })

// 3. Core services. The cache wraps the issuer exchanger and implements the
// same port, so the gateway service cannot tell them apart. One cache per
// process: exchanged tokens are reused across requests until shortly before expiry.
const tokenVerifier = new AudienceTokenVerifier(jwtVerifier, config.TOKEN_AUDIENCE)
const exchanger = new CachingTokenExchanger(issuerExchanger, clock, { refreshMarginSeconds: 30, maxEntries: 1000 })
const gateway = new DefaultGatewayService(exchanger, targetClient, STATIC_TARGETS)

// 4. Driving side: authentication, per-request server factory, HTTP handlers.
const authenticator = new BearerAuthenticator(tokenVerifier, resourceMetadataUrl)
const serverFactory = new GatewayServerFactory(gateway)
const mcpHandler = new McpHttpHandler(authenticator, serverFactory, logger, { traceMode: 'start' })
const metadataHandler = new ProtectedResourceHandler(
  protectedResourceMetadata(resource, config.ISSUER_URL, STATIC_TARGETS),
)

// 5. HTTP routes. createMcpExpressApp parses JSON and, because HOST is
// loopback, rejects requests whose Host header is not localhost.
const app = createMcpExpressApp({ host: HOST })
// Served at the path-specific URL and at the root, for clients that only try the root.
app.get(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], (req, res) =>
  metadataHandler.handle(req, res),
)
app.post('/mcp', (req, res) => mcpHandler.handle(req, res))
app.all('/mcp', (req, res) => mcpHandler.methodNotAllowed(req, res))

app.listen(config.GATEWAY_PORT, HOST, (err?: Error) => {
  if (err) {
    logger.error('gateway failed to start', { err })
    process.exit(1)
  }
  logger.info('gateway listening', {
    host: HOST,
    port: config.GATEWAY_PORT,
    resource,
    issuer: config.ISSUER_URL,
    targets: STATIC_TARGETS.map((t) => t.id),
  })
})
