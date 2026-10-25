import { z } from 'zod'
import { TokenExchangeError } from '../../core/errors.ts'
import type { Clock } from '../../core/ports/clock.ts'
import type { ExchangedToken, TokenExchanger, TokenExchangeRequest } from '../../core/ports/token-exchanger.ts'

const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token'

const responseSchema = z.object({
  access_token: z.string().min(1),
  issued_token_type: z.literal(ACCESS_TOKEN_TYPE),
  expires_in: z.number().int().positive(),
})

export interface OAuthTokenExchangerOptions {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  timeoutMs: number
}

/** RFC 8693 token exchange against an OAuth token endpoint, authenticated as the gateway client. */
export class OAuthTokenExchanger implements TokenExchanger {
  private readonly options: OAuthTokenExchangerOptions
  private readonly clock: Clock
  private readonly basic: string

  constructor(options: OAuthTokenExchangerOptions, clock: Clock) {
    this.options = options
    this.clock = clock
    // RFC 6749 §2.3.1: id and secret are form-urlencoded before base64.
    this.basic = Buffer.from(
      `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
    ).toString('base64')
  }

  async exchange(request: TokenExchangeRequest): Promise<ExchangedToken> {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: request.subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: request.audience,
      scope: request.scopes.join(' '),
    })
    let response: Response
    try {
      response = await fetch(this.options.tokenEndpoint, {
        method: 'POST',
        headers: { Authorization: `Basic ${this.basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
    } catch (err) {
      throw new TokenExchangeError({ cause: err })
    }

    const json: unknown = await response.json().catch(() => undefined)
    if (!response.ok) {
      // The OAuth error code goes to the log through `cause`, never to the agent.
      throw new TokenExchangeError({ cause: { status: response.status, body: json } })
    }
    const parsed = responseSchema.safeParse(json)
    if (!parsed.success) throw new TokenExchangeError({ cause: parsed.error })
    return {
      accessToken: parsed.data.access_token,
      expiresAt: this.clock.nowSeconds() + parsed.data.expires_in,
    }
  }
}
