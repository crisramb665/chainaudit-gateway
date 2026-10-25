import type { Request, Response } from 'express'
import type { TargetConfig } from '../../core/gateway/targets.ts'

/** OAuth 2.0 Protected Resource Metadata (RFC 9728) for the gateway's /mcp endpoint. */
export function protectedResourceMetadata(
  resource: string,
  issuer: string,
  targets: TargetConfig[],
  extraScopes: string[] = [],
) {
  const scopes = new Set([...targets.flatMap((t) => Object.values(t.toolScopes)), ...extraScopes])
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...scopes].sort(),
    bearer_methods_supported: ['header'],
    resource_name: 'ChainAudit Gateway',
  }
}

/** Serves the protected resource metadata document. */
export class ProtectedResourceHandler {
  private readonly metadata: ReturnType<typeof protectedResourceMetadata>

  constructor(metadata: ReturnType<typeof protectedResourceMetadata>) {
    this.metadata = metadata
  }

  handle(_req: Request, res: Response): void {
    res.json(this.metadata)
  }
}
