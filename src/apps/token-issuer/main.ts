// LEARN: This file is the composition root of the token issuer: the one place
// that reads configuration, picks concrete adapters (scrypt, jose, a JSON file
// of clients) and wires the object graph in dependency order. The grant logic
// in core only sees interfaces, so it can be tested with fakes and would run
// unchanged with secrets from a vault or keys from a KMS. Keeping wiring in
// one place keeps the graph readable top to bottom.
import express from 'express'
import type { JSONWebKeySet } from 'jose'
import { FileSigningKeyStore, SIGNING_ALG } from '../../adapters/local/file-signing-key-store.ts'
import { JoseAccessTokenSigner } from '../../adapters/local/jose-access-token-signer.ts'
import { JoseJwtVerifier } from '../../adapters/local/jose-jwt-verifier.ts'
import { JsonFileClientRegistry } from '../../adapters/local/json-file-client-registry.ts'
import { JsonLogger } from '../../adapters/local/json-logger.ts'
import { ScryptSecretHasher } from '../../adapters/local/scrypt-secret-hasher.ts'
import { SystemClock } from '../../adapters/local/system-clock.ts'
import { DefaultTokenIssuer } from '../../core/issuer/token-issuer.ts'
import { parseConfig } from './config.ts'
import { JwksHandler } from './jwks-handler.ts'
import { TokenEndpointHandler } from './token-endpoint-handler.ts'

const HOST = '127.0.0.1'

// 1. Configuration, read and validated once.
const config = parseConfig(process.env)

// 2. Adapters (driven side). Loading the key and the clients file happens at
// startup, so a bad key or clients file fails fast instead of on a request.
const logger = new JsonLogger({ service: 'token-issuer' })
const clock = new SystemClock()
const signingKey = await FileSigningKeyStore.loadOrCreate(config.ISSUER_KEY_FILE)
const jwks: JSONWebKeySet = {
  keys: [{ ...signingKey.publicJwk, kid: signingKey.kid, alg: SIGNING_ALG, use: 'sig' }],
}
const clients = await JsonFileClientRegistry.load(config.CLIENTS_FILE)
const secrets = new ScryptSecretHasher()
const signer = new JoseAccessTokenSigner(signingKey, config.ISSUER_URL)
// Subject tokens in token exchange are verified against the issuer's own keys.
const subjectVerifier = new JoseJwtVerifier(JoseJwtVerifier.localKeys(jwks), {
  issuer: config.ISSUER_URL,
  clockTolerance: 0,
})

// 3. Core service.
const issuer = new DefaultTokenIssuer(clients, secrets, signer, subjectVerifier, clock, {
  audience: config.TOKEN_AUDIENCE,
  ttlSeconds: config.TOKEN_TTL_SECONDS,
  exchangeTtlSeconds: config.EXCHANGE_TTL_SECONDS,
})

// 4. Driving side: HTTP handlers.
const tokenHandler = new TokenEndpointHandler(issuer, logger)
const jwksHandler = new JwksHandler(jwks)

// 5. HTTP routes. The handler takes a plain event, so Express only translates.
const app = express()
app.post('/oauth2/token', express.urlencoded({ extended: false }), async (req, res) => {
  const result = await tokenHandler.handle({
    authorization: req.header('authorization'),
    traceparent: req.header('traceparent'),
    body: req.body ?? {},
  })
  res.status(result.status).set(result.headers).json(result.body)
})
app.get('/.well-known/jwks.json', (req, res) => jwksHandler.handle(req, res))

app.listen(config.ISSUER_PORT, HOST, (err?: Error) => {
  if (err) {
    logger.error('token issuer failed to start', { err })
    process.exit(1)
  }
  logger.info('token issuer listening', {
    host: HOST,
    port: config.ISSUER_PORT,
    issuer: config.ISSUER_URL,
    audience: config.TOKEN_AUDIENCE,
    kid: signingKey.kid,
  })
})
