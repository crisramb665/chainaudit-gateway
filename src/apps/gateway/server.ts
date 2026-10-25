import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { CachingTokenExchanger } from '../../core/auth/caching-token-exchanger.ts'
import { TokenExchangeError } from '../../core/errors.ts'
import {
  isToolVisible,
  missingScope,
  namespacedName,
  parseNamespacedName,
  requiredScope,
  scopesForTarget,
} from '../../core/gateway/catalog.ts'
import type { TargetConfig } from '../../core/gateway/targets.ts'
import type { Logger } from '../../core/ports/logger.ts'
import type { Principal } from '../../core/ports/token-verifier.ts'
import { withTargetClient } from './target-client.ts'

export interface GatewayServerDeps {
  // The verified caller. Tenant and scopes come only from here.
  principal: Principal
  // LEARN: The caller's raw token is only ever sent to the issuer as the
  // subject of a token exchange. Targets receive a new token minted for them;
  // forwarding this one would make them accept tokens addressed to the gateway.
  subjectToken: string
  exchanger: CachingTokenExchanger
  targets: TargetConfig[]
  logger: Logger
  traceparent: string
  timeoutMs: number
}

// The low-level Server is used because upstream tools arrive with JSON
// Schemas already built; McpServer.registerTool expects zod schemas.
export function buildGatewayServer(deps: GatewayServerDeps): Server {
  const server = new Server({ name: 'chainaudit-gateway', version: '0.1.0' }, { capabilities: { tools: {} } })

  // A token for exactly this target and these scopes, on behalf of the caller.
  const tokenFor = (target: TargetConfig, scopes: string[]) =>
    deps.exchanger.exchange({
      subjectToken: deps.subjectToken,
      subjectTokenId: deps.principal.tokenId,
      audience: target.audience,
      scopes,
    })
  const callOptions = (accessToken: string) => ({
    accessToken,
    traceparent: deps.traceparent,
    timeoutMs: deps.timeoutMs,
  })

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const perTarget = await Promise.allSettled(
      deps.targets.map(async (target): Promise<Tool[]> => {
        // The caller holds no scope this target uses: nothing would be visible,
        // so the target is not called at all.
        const scopes = scopesForTarget(deps.principal, target)
        if (scopes.length === 0) return []
        const token = await tokenFor(target, scopes)
        deps.logger.info('target token', { target_id: target.id, exchange: token.cache, scope: scopes.join(' ') })
        return withTargetClient(target, callOptions(token.accessToken), async (client, options) => {
          const { tools } = await client.listTools(undefined, options)
          return tools
            .filter((tool) => isToolVisible(deps.principal, target, tool.name))
            .map((tool): Tool => ({ ...tool, name: namespacedName(target.id, tool.name) }))
        })
      }),
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
      // Only the one scope this tool needs, even if the caller holds more.
      const token = await tokenFor(target, [scope])
      deps.logger.info('target token', { target_id: target.id, exchange: token.cache, scope })
      // The target's result, including its own isError results, passes through unchanged.
      return (await withTargetClient(target, callOptions(token.accessToken), (client, options) =>
        client.callTool({ name: parsed.tool, arguments: request.params.arguments ?? {} }, undefined, options),
      )) as CallToolResult
    } catch (err) {
      if (err instanceof TokenExchangeError) {
        deps.logger.error('token exchange failed', { target_id: target.id, tool: name, err })
        return toolError(`Could not authorize the call to target ${target.id}`)
      }
      deps.logger.error('target call failed', { target_id: target.id, tool: name, err })
      return toolError(`Target ${target.id} is unavailable`)
    }
  })

  return server
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
