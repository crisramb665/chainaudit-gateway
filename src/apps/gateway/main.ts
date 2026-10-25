import { randomBytes } from 'node:crypto'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { createJoseTokenVerifier } from '../../adapters/local/jose-token-verifier.ts'
import { createJsonLogger } from '../../adapters/local/json-logger.ts'
import { createOAuthTokenExchanger } from '../../adapters/local/oauth-token-exchanger.ts'
import { cachingTokenExchanger } from '../../core/auth/caching-token-exchanger.ts'
import { authenticate } from '../shared/bearer-auth.ts'
import { protectedResourceMetadata } from './resource-metadata.ts'
import { loadConfig } from './config.ts'
import { buildGatewayServer } from './server.ts'
import { targets } from './targets.ts'

const HOST = '127.0.0.1'
const config = loadConfig()
const rootLogger = createJsonLogger({ service: 'gateway' })
const verifier = createJoseTokenVerifier({
  jwksUrl: config.JWKS_URL,
  issuer: config.ISSUER_URL,
  audience: config.TOKEN_AUDIENCE,
})
// One cache per process: exchanged tokens are reused across requests until shortly before expiry.
const exchanger = cachingTokenExchanger(
  createOAuthTokenExchanger({
    tokenEndpoint: config.TOKEN_ENDPOINT,
    clientId: config.GATEWAY_CLIENT_ID,
    clientSecret: config.GATEWAY_CLIENT_SECRET,
    timeoutMs: config.EXCHANGE_TIMEOUT_MS,
  }),
)

const resource = `${config.GATEWAY_URL}/mcp`
// RFC 9728 §3.1: the well-known segment goes between host and resource path.
const resourceMetadataUrl = `${config.GATEWAY_URL}/.well-known/oauth-protected-resource/mcp`
const metadata = protectedResourceMetadata(resource, config.ISSUER_URL, targets)

const app = createMcpExpressApp({ host: HOST })

// Served at the path-specific URL and at the root, for clients that only try the root.
app.get(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'], (_req, res) => {
  res.json(metadata)
})

app.post('/mcp', async (req: Request, res: Response) => {
  const startedAt = performance.now()
  // LEARN: The trace starts here, at the edge. An incoming traceparent from
  // the agent is ignored so callers cannot inject or collide with trace ids;
  // this one is sent to every target so their logs share the trace_id.
  const traceId = randomBytes(16).toString('hex')
  const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`
  let logger = rootLogger.child({ trace_id: traceId })

  res.on('close', () => {
    logger.info('mcp request', {
      rpc_method: req.body?.method,
      tool: req.body?.params?.name,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - startedAt),
    })
  })

  const auth = await authenticate(req.header('authorization'), verifier, resourceMetadataUrl).catch((err) => {
    logger.error('authentication failed unexpectedly', { err })
    return { ok: false as const, status: 500, headers: {}, body: { error: 'server_error' }, reason: 'internal' }
  })
  if (!auth.ok) {
    logger.info('request rejected', { status: auth.status, reason: auth.reason })
    res.status(auth.status).set(auth.headers).json(auth.body)
    return
  }
  const { principal, token: subjectToken } = auth
  logger = logger.child({ tenant_id: principal.tenantId, sub: principal.subject })

  // Same stateless pattern as the MCP server: new server and transport per request.
  const server = buildGatewayServer({
    principal,
    subjectToken,
    exchanger,
    targets,
    logger,
    traceparent,
    timeoutMs: config.TARGET_TIMEOUT_MS,
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    logger.error('mcp transport failed', { err })
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
    }
  }
})

app.all('/mcp', (_req: Request, res: Response) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
})

app.listen(config.GATEWAY_PORT, HOST, (err?: Error) => {
  if (err) {
    rootLogger.error('gateway failed to start', { err })
    process.exit(1)
  }
  rootLogger.info('gateway listening', {
    host: HOST,
    port: config.GATEWAY_PORT,
    resource,
    issuer: config.ISSUER_URL,
    targets: targets.map((t) => t.id),
  })
})
