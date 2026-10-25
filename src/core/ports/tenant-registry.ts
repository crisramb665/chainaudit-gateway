export type TargetStatus = 'pending' | 'active' | 'disabled'

/** A target a tenant registered: its own MCP server. Holds a reference to the secret, never the secret. */
export interface TenantTarget {
  tenantId: string
  targetId: string
  name: string
  baseUrl: string
  authType: 'api_key'
  secretRef: string
  status: TargetStatus
  statusReason?: string
  /** Incremented on every update, for optimistic concurrency. */
  version: number
  /** ISO 8601. */
  createdAt: string
}

export type CreateTargetResult = 'created' | 'duplicate' | 'quota_exceeded' | 'unknown_tenant'

// LEARN: Interface segregation. Routing only needs to read a tenant's active
// targets, so it depends on this narrow port, which a cache can decorate
// cheaply. Only registration gets the full read-write TenantRegistry.
export interface TenantTargetReader {
  /** The tenant's targets with status active. Always scoped to one tenant. */
  listActiveTargets(tenantId: string): Promise<TenantTarget[]>
}

export interface TenantRegistry extends TenantTargetReader {
  getTarget(tenantId: string, targetId: string): Promise<TenantTarget | undefined>
  /** Creates the target and counts it against the tenant's quota, atomically. */
  createTarget(target: TenantTarget): Promise<CreateTargetResult>
  /** Updates status if the stored version still equals `expectedVersion`. */
  updateTargetStatus(
    tenantId: string,
    targetId: string,
    expectedVersion: number,
    status: TargetStatus,
    reason: string | undefined,
  ): Promise<TenantTarget | 'version_conflict'>
}
