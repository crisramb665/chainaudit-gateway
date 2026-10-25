import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import {
  isToolVisible,
  missingScope,
  namespacedName,
  parseNamespacedName,
  requiredScope,
} from '../../core/gateway/catalog.ts'
import type { TargetConfig } from '../../core/gateway/targets.ts'
import type { Logger } from '../../core/ports/logger.ts'
import type { Principal } from '../../core/ports/token-verifier.ts'
import { withTargetClient } from './target-client.ts'

export interface GatewayServerDeps {
  // The verified caller. Tenant and scopes come only from here.
  principal: Principal
  targets: TargetConfig[]
  logger: Logger
  traceparent: string
  timeoutMs: number
}

// The low-level Server is used because upstream tools arrive with JSON
// Schemas already built; McpServer.registerTool expects zod schemas.
export function buildGatewayServer(deps: GatewayServerDeps): Server {
  const server = new Server({ name: 'chainaudit-gateway', version: '0.1.0' }, { capabilities: { tools: {} } })
  const callOptions = { traceparent: deps.traceparent, timeoutMs: deps.timeoutMs }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const perTarget = await Promise.allSettled(
      deps.targets.map((target) =>
        withTargetClient(target, callOptions, async (client, options) => {
          const { tools } = await client.listTools(undefined, options)
          return tools
            .filter((tool) => isToolVisible(deps.principal, target, tool.name))
            .map((tool): Tool => ({ ...tool, name: namespacedName(target.id, tool.name) }))
        }),
      ),
    )
    // LEARN: A failing target drops out of the catalog instead of failing the
    // whole list, so one broken backend cannot hide every other target's tools.
    return {
      tools: perTarget.flatMap((result, i) => {
        if (result.status === 'fulfilled') return result.value
        deps.logger.error('target list failed', { target_id: deps.targets[i]?.id, err: result.reason })
        return []
      }),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name
    const parsed = parseNamespacedName(name)
    const target = parsed && deps.targets.find((t) => t.id === parsed.targetId)
    const scope = parsed && target && requiredScope(target, parsed.tool)
    if (!parsed || !target || !scope) return toolError(`Unknown tool ${name}`)

    const missing = missingScope(deps.principal, scope)
    if (missing) {
      deps.logger.info('tool call denied', { tool: name, required_scope: missing })
      return toolError(`Tool ${name} requires scope ${missing}`)
    }

    try {
      // The target's result, including its own isError results, passes through unchanged.
      return (await withTargetClient(target, callOptions, (client, options) =>
        client.callTool({ name: parsed.tool, arguments: request.params.arguments ?? {} }, undefined, options),
      )) as CallToolResult
    } catch (err) {
      deps.logger.error('target call failed', { target_id: target.id, tool: name, err })
      return toolError(`Target ${target.id} is unavailable`)
    }
  })

  return server
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
