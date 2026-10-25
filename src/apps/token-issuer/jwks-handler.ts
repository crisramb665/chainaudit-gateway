import type { Request, Response } from 'express'
import type { JSONWebKeySet } from 'jose'

/** GET /.well-known/jwks.json: public keys only. */
export class JwksHandler {
  private readonly jwks: JSONWebKeySet

  constructor(jwks: JSONWebKeySet) {
    this.jwks = jwks
  }

  handle(_req: Request, res: Response): void {
    // Verifiers may cache the keys for a few minutes.
    res.set('Cache-Control', 'public, max-age=300').json(this.jwks)
  }
}
