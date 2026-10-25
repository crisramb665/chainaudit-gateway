// LEARN: DefaultTokenIssuer receives every collaborator through its
// constructor, typed by ports: the client registry, the secret check, the
// signer, the subject-token verifier and the clock. The test replaces each one
// with a few lines of fake, including a fixed clock, so expiry rules can be
// checked exactly, with no keys, no scrypt cost and no HTTP.
import { describe, expect, it } from 'vitest'
import type { AccessTokenClaims, AccessTokenSigner } from '../ports/access-token-signer.ts'
import type { Clock } from '../ports/clock.ts'
import { CLIENT_CREDENTIALS, TOKEN_EXCHANGE, type ClientRegistry, type OAuthClient } from '../ports/client-registry.ts'
import type { JwtVerifier } from '../ports/jwt-verifier.ts'
import type { Logger } from '../ports/logger.ts'
import type { SecretVerifier } from '../ports/secret-verifier.ts'
import type { Principal } from '../ports/token-verifier.ts'
import { DefaultTokenIssuer } from './token-issuer.ts'

const NOW = 1_800_000_000
const ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token'

const CLIENTS: OAuthClient[] = [
  {
    client_id: 'agent-acme',
    tenant_id: 'acme',
    allowed_grant_types: [CLIENT_CREDENTIALS],
    allowed_scopes: ['chain:read', 'recon:read'],
    secret_hash: 'acme-secret',
  },
  {
    client_id: 'chainaudit-gateway',
    allowed_grant_types: [TOKEN_EXCHANGE],
    allowed_scopes: [],
    subject_audience: 'chainaudit-gateway',
    allowed_audiences: ['chainaudit-mcp'],
    secret_hash: 'gateway-secret',
  },
]

class InMemoryClients implements ClientRegistry {
  findClient(clientId: string): OAuthClient | undefined {
    return CLIENTS.find((c) => c.client_id === clientId)
  }
}

/** The "hash" is the secret itself: fine for a fake, the real one is scrypt. */
class PlainSecrets implements SecretVerifier {
  async verify(secret: string, encodedHash: string | undefined): Promise<boolean> {
    return encodedHash !== undefined && secret === encodedHash
  }
}

class RecordingSigner implements AccessTokenSigner {
  readonly signed: AccessTokenClaims[] = []

  async sign(claims: AccessTokenClaims): Promise<{ token: string; jti: string }> {
    this.signed.push(claims)
    return { token: `signed-${this.signed.length}`, jti: `jti-${this.signed.length}` }
  }
}

/** Accepts one known subject token, addressed to the gateway. */
class StubSubjectVerifier implements JwtVerifier {
  private readonly subject: Principal

  constructor(subject: Principal) {
    this.subject = subject
  }

  async verify(token: string, audience: string): Promise<Principal> {
    if (token !== 'agent-token' || audience !== 'chainaudit-gateway') throw new Error('invalid')
    return this.subject
  }
}

const fixedClock: Clock = { nowSeconds: () => NOW }
const silentLogger: Logger = { info: () => {}, error: () => {}, child: () => silentLogger }
const policy = { audience: 'chainaudit-gateway', ttlSeconds: 900, exchangeTtlSeconds: 300 }

function build(subjectExpiresAt = NOW + 900) {
  const signer = new RecordingSigner()
  const subject: Principal = {
    subject: 'agent-acme',
    tenantId: 'acme',
    scopes: ['chain:read'],
    tokenId: 'agent-jti',
    expiresAt: subjectExpiresAt,
  }
  const issuer = new DefaultTokenIssuer(
    new InMemoryClients(),
    new PlainSecrets(),
    signer,
    new StubSubjectVerifier(subject),
    fixedClock,
    policy,
  )
  return { issuer, signer }
}

const exchangeParams = (scope: string) => ({
  grant_type: TOKEN_EXCHANGE,
  subject_token: 'agent-token',
  subject_token_type: ACCESS_TOKEN,
  audience: 'chainaudit-mcp',
  scope,
})

describe('DefaultTokenIssuer (token-issuer core)', () => {
  it('client credentials: signs a gateway token that expires exactly 15 minutes from now', async () => {
    const { issuer, signer } = build()

    const outcome = await issuer.issue(
      { clientId: 'agent-acme', clientSecret: 'acme-secret', params: { grant_type: CLIENT_CREDENTIALS } },
      silentLogger,
    )

    expect(outcome).toMatchObject({ ok: true, body: { token_type: 'Bearer', expires_in: 900 } })
    expect(signer.signed).toEqual([
      {
        audience: 'chainaudit-gateway',
        subject: 'agent-acme',
        tenantId: 'acme',
        scope: 'chain:read recon:read',
        issuedAt: NOW,
        expiresAt: NOW + 900,
      },
    ])
  })

  it('token exchange: a scope the subject token lacks is invalid_scope and nothing is signed', async () => {
    const { issuer, signer } = build()

    const outcome = await issuer.issue(
      { clientId: 'chainaudit-gateway', clientSecret: 'gateway-secret', params: exchangeParams('recon:write') },
      silentLogger,
    )

    expect(outcome).toMatchObject({ ok: false, error: 'invalid_scope' })
    expect(signer.signed).toEqual([])
  })

  it('token exchange: the new token never outlives the subject token', async () => {
    const { issuer, signer } = build(NOW + 120)

    const outcome = await issuer.issue(
      { clientId: 'chainaudit-gateway', clientSecret: 'gateway-secret', params: exchangeParams('chain:read') },
      silentLogger,
    )

    expect(outcome).toMatchObject({ ok: true, body: { expires_in: 120, scope: 'chain:read' } })
    expect(signer.signed[0]).toMatchObject({
      audience: 'chainaudit-mcp',
      subject: 'agent-acme',
      tenantId: 'acme',
      actor: 'chainaudit-gateway',
      expiresAt: NOW + 120,
    })
  })
})
