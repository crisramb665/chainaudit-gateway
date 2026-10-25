import type { Principal } from '../ports/token-verifier.ts'
import type { TargetConfig } from './targets.ts'

const SEPARATOR = '__'

export function namespacedName(targetId: string, tool: string): string {
  return `${targetId}${SEPARATOR}${tool}`
}

/** Splits `<target>__<tool>` on the first separator, so tool names may contain `__`. */
export function parseNamespacedName(name: string): { targetId: string; tool: string } | undefined {
  const index = name.indexOf(SEPARATOR)
  if (index <= 0 || index + SEPARATOR.length >= name.length) return undefined
  return { targetId: name.slice(0, index), tool: name.slice(index + SEPARATOR.length) }
}

// LEARN: Default deny. A tool the target exposes but the scope map does not
// mention has no required scope, and "no rule" means "nobody", not "everybody".
// Adding a tool to a backend therefore never silently exposes it to agents.
export function requiredScope(target: TargetConfig, tool: string): string | undefined {
  return Object.hasOwn(target.toolScopes, tool) ? target.toolScopes[tool] : undefined
}

// LEARN: The catalog is filtered so an agent only discovers tools it may use:
// its model does not plan around tools that will be refused, its context is
// not filled with them, and it learns nothing about capabilities (later, other
// tenants' targets) it has no right to see. Filtering is only a view, though;
// the same check runs again on every tools/call (see missingScope).
export function isToolVisible(principal: Principal, target: TargetConfig, tool: string): boolean {
  const scope = requiredScope(target, tool)
  return scope !== undefined && principal.scopes.includes(scope)
}

// LEARN: Checked again on tools/call because nothing forces a caller to list
// first: any client can send any tool name, a stateless request carries no
// memory of an earlier list, and the token used now may be narrower than the
// one used to list. Authorization must happen at the moment of use.
/** The scope the caller lacks for this tool, or undefined when allowed. */
export function missingScope(principal: Principal, scope: string): string | undefined {
  return principal.scopes.includes(scope) ? undefined : scope
}

/** The caller's scopes that this target uses: what a token for listing its tools needs, and no more. */
export function scopesForTarget(principal: Principal, target: TargetConfig): string[] {
  const used = new Set(Object.values(target.toolScopes))
  return principal.scopes.filter((scope) => used.has(scope)).sort()
}
