// LEARN: This file is the composition root of the gateway: the one place that
// reads configuration, picks concrete adapters and wires the object graph in
// dependency order. Everything else receives its collaborators through the
// constructor, typed by interfaces, and never knows which implementation it
// got. Moving to AWS (another token verifier, a registry instead of static
// targets) changes lines here, not the gateway's logic. Keeping wiring in one
// place also keeps the graph readable top to bottom, and makes every other
// class testable with fakes.
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { DynamoDbTenantRegistry } from '../../adapters/aws/dynamodb-tenant-registry.ts'
import { FileCredentialProvider } from '../../adapters/local/file-credential-provider.ts'
import { JoseJwtVerifier } from '../../adapters/local/jose-jwt-verifier.ts'
import { JsonLogger } from '../../adapters/local/json-logger.ts'
import { McpTargetClient } from '../../adapters/local/mcp-target-client.ts'
import { NodeDnsResolver } from '../../adapters/local/node-dns-resolver.ts'
import { OAuthTokenExchanger } from '../../adapters/local/oauth-token-exchanger.ts'
import { SystemClock } from '../../adapters/local/system-clock.ts'
import { AudienceTokenVerifier } from '../../core/auth/audience-token-verifier.ts'
import { CachingTokenExchanger } from '../../core/auth/caching-token-exchanger.ts'
import { DefaultEgressValidator } from '../../core/egress/egress-validator.ts'
import { TENANT_TOOLS_SCOPE } from '../../core/gateway/catalog.ts'
import { DefaultGatewayService } from '../../core/gateway/gateway-service.ts'
import { CachingTenantTargetReader } from '../../core/registry/caching-target-reader.ts'
import { DefaultTargetRegistrar } from '../../core/registry/target-registrar.ts'
import { CircuitBreakers } from '../../core/resilience/circuit-breakers.ts'
import { BearerAuthenticator } from '../shared/bearer-auth.ts'
import { McpHttpHandler } from '../shared/mcp-http-handler.ts'
import { parseConfig } from './config.ts'
import { GatewayServerFactory } from './gateway-server-factory.ts'
import { RegisterTargetHandler } from './register-target-handler.ts'
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
const registry = new DynamoDbTenantRegistry({
  tableName: config.REGISTRY_TABLE,
  region: config.AWS_REGION,
  ...(config.DYNAMODB_ENDPOINT ? { endpoint: config.DYNAMODB_ENDPOINT } : {}),
})
const credentials = new FileCredentialProvider({ dir: config.SECRETS_DIR })
const dnsResolver = new NodeDnsResolver({ timeoutMs: config.DNS_TIMEOUT_MS })

// 3. Core services. The cache wraps the issuer exchanger and implements the
// same port, so the gateway service cannot tell them apart. One cache per
// process: exchanged tokens are reused across requests until shortly before expiry.
const tokenVerifier = new AudienceTokenVerifier(jwtVerifier, config.TOKEN_AUDIENCE)
const exchanger = new CachingTokenExchanger(issuerExchanger, clock, { refreshMarginSeconds: 30, maxEntries: 1000 })
const egress = new DefaultEgressValidator(dnsResolver, { allowPrivateNetworks: config.EGRESS_ALLOW_PRIVATE_NETWORKS })
// Routing reads tenant targets through a 30 s cache; registration writes go to the registry directly.
const tenantTargets = new CachingTenantTargetReader(registry, clock, {
  ttlSeconds: config.REGISTRY_CACHE_SECONDS,
  maxTenants: 1000,
})
// One breaker per tenant + target, in memory in this process.
const breakers = new CircuitBreakers(clock, {
  windowSize: config.BREAKER_WINDOW,
  failureRate: config.BREAKER_FAILURE_RATE,
  openSeconds: config.BREAKER_OPEN_SECONDS,
})
const gateway = new DefaultGatewayService(
  exchanger,
  targetClient,
  STATIC_TARGETS,
  tenantTargets,
  credentials,
  egress,
  breakers,
  { tenantTargetTimeoutMs: config.TENANT_TARGET_TIMEOUT_MS },
)
const registrar = new DefaultTargetRegistrar(registry, credentials, targetClient, egress, clock, {
  reservedTargetIds: STATIC_TARGETS.map((t) => t.id),
})

// 4. Driving side: authentication, per-request server factory, HTTP handlers.
const authenticator = new BearerAuthenticator(tokenVerifier, resourceMetadataUrl)
const serverFactory = new GatewayServerFactory(gateway)
const mcpHandler = new McpHttpHandler(authenticator, serverFactory, logger, { traceMode: 'start' })
const registerHandler = new RegisterTargetHandler(authenticator, registrar, logger)
const metadataHandler = new ProtectedResourceHandler(
  protectedResourceMetadata(resource, config.ISSUER_URL, STATIC_TARGETS, [TENANT_TOOLS_SCOPE]),
)

// 5. HTTP routes. createMcpExpressApp parses JSON and, because HOST is
// loopback, rejects requests whose Host header is not localhost.
const app = createMcpExpressApp({ host: HOST })
// Served at the path-specific URL and at the root, for clients that only try the root.
app.get(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], (req, res) =>
  metadataHandler.handle(req, res),
)
app.post('/mcp', (req, res) => mcpHandler.handle(req, res))
app.post('/admin/targets', async (req, res) => {
  const result = await registerHandler.handle({
    authorization: req.header('authorization'),
    traceparent: req.header('traceparent'),
    body: req.body,
  })
  res.status(result.status).set(result.headers).json(result.body)
})
app.all('/mcp', (req, res) => mcpHandler.methodNotAllowed(req, res))

app.listen(config.GATEWAY_PORT, HOST, (err?: Error) => {
  if (err) {
    logger.error('gateway failed to start', { err })
    process.exit(1)
  }
  if (config.EGRESS_ALLOW_PRIVATE_NETWORKS) {
    logger.warn('egress: private networks allowed for tenant targets (APP_ENV=local)', { app_env: config.APP_ENV })
  }
  logger.info('gateway listening', {
    host: HOST,
    port: config.GATEWAY_PORT,
    resource,
    issuer: config.ISSUER_URL,
    targets: STATIC_TARGETS.map((t) => t.id),
    registry: config.REGISTRY_TABLE,
    app_env: config.APP_ENV,
  })
})
