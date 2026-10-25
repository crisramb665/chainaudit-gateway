import { randomUUID } from 'node:crypto'
import express, { type Request, type Response } from 'express'
import { createLocalJWKSet } from 'jose'
import { createJsonLogger } from '../../adapters/local/json-logger.ts'
import { loadClientRegistry } from './clients.ts'
import { loadConfig } from './config.ts'
import { oauthError, type HttpResult } from './oauth-errors.ts'
import { SIGNING_ALG, loadOrCreateSigningKey } from './signing-key.ts'
import { handleTokenRequest } from './token-handler.ts'

const HOST = '127.0.0.1'
const config = loadConfig()
const rootLogger = createJsonLogger({ service: 'token-issuer' })
const clients = await loadClientRegistry(config.CLIENTS_FILE)
const signingKey = await loadOrCreateSigningKey(config.ISSUER_KEY_FILE)
const jwks = { keys: [{ ...signingKey.publicJwk, kid: signingKey.kid, alg: SIGNING_ALG, use: 'sig' }] }
// Subject tokens in token exchange are verified against the issuer's own keys.
const ownKeys = createLocalJWKSet(jwks)

const app = express()

app.post('/oauth2/token', express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
  const logger = rootLogger.child({ trace_id: traceIdFrom(req) })
  let result: HttpResult
  try {
    result = await handleTokenRequest(
      {
        clients,
        signingKey,
        issuer: config.ISSUER_URL,
        audience: config.TOKEN_AUDIENCE,
        ttlSeconds: config.TOKEN_TTL_SECONDS,
        ownKeys,
        exchangeTtlSeconds: config.EXCHANGE_TTL_SECONDS,
        logger,
      },
      { authorization: req.header('authorization'), body: req.body ?? {} },
    )
  } catch (err) {
    logger.error('token request failed', { err })
    result = oauthError(500, 'server_error', 'Unexpected error while issuing the token')
  }
  res.status(result.status).set(result.headers).json(result.body)
})

app.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
  // Public keys only. Verifiers may cache them for a few minutes.
  res.set('Cache-Control', 'public, max-age=300').json(jwks)
})

app.listen(config.ISSUER_PORT, HOST, (err?: Error) => {
  if (err) {
    rootLogger.error('token issuer failed to start', { err })
    process.exit(1)
  }
  rootLogger.info('token issuer listening', {
    host: HOST,
    port: config.ISSUER_PORT,
    issuer: config.ISSUER_URL,
    audience: config.TOKEN_AUDIENCE,
    kid: signingKey.kid,
  })
})

function traceIdFrom(req: Request): string {
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(req.header('traceparent') ?? '')
  return match?.[1] ?? randomUUID().replaceAll('-', '')
}
