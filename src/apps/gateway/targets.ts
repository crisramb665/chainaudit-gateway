import type { TargetConfig } from '../../core/gateway/targets.ts'

// Static route table until the tenant registry arrives in task 5. Scopes
// follow the tool table in the RFC; only tools that exist today are listed.
export const targets: TargetConfig[] = [
  {
    id: 'chain',
    url: 'http://127.0.0.1:3001/mcp',
    audience: 'chainaudit-mcp',
    toolScopes: { get_balance: 'chain:read' },
  },
]
