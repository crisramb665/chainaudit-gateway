/** Tenant ids and target ids: lowercase slugs, which also rules out `/` and `..` in paths. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Where a target's credential lives, mirroring Secrets Manager naming: /tenants/<tenant>/targets/<target>. */
export function secretRefFor(tenantId: string, targetId: string): string {
  if (!ID_PATTERN.test(tenantId) || !ID_PATTERN.test(targetId)) throw new Error('invalid tenant or target id')
  return `/tenants/${tenantId}/targets/${targetId}`
}

/** The tenant a secret ref belongs to, or undefined if the ref is malformed. */
export function tenantOfSecretRef(secretRef: string): string | undefined {
  const match = /^\/tenants\/([^/]+)\/targets\/([^/]+)$/.exec(secretRef)
  if (!match?.[1] || !match[2] || !ID_PATTERN.test(match[1]) || !ID_PATTERN.test(match[2])) return undefined
  return match[1]
}
