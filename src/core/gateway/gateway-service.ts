import { TokenExchangeError } from '../errors.ts'
import type { Logger } from '../ports/logger.ts'
import type { TargetClient, ToolDefinition, ToolResult } from '../ports/target-client.ts'
import type { ExchangedToken, TokenExchanger } from '../ports/token-exchanger.ts'
import type { Principal } from '../ports/token-verifier.ts'
import {
  isToolVisible,
  missingScope,
  namespacedName,
  parseNamespacedName,
  requiredScope,
  scopesForTarget,
} from './catalog.ts'
import type { TargetConfig } from './targets.ts'

/** The verified caller of one request. */
export interface Caller {
  // The verified caller. Tenant and scopes come only from here.
  principal: Principal
  // LEARN: The caller's raw token is only ever sent to the issuer as the
  // subject of a token exchange. Targets receive a new token minted for them;
  // forwarding this one would make them accept tokens addressed to the gateway.
  subjectToken: string
}

/** Request-scoped values, passed per call rather than held in fields. */
export interface RequestContext {
  traceparent: string
  logger: Logger
}

/** What the gateway's MCP layer needs from core. */
export interface GatewayService {
  listTools(caller: Caller, context: RequestContext): Promise<ToolDefinition[]>
  callTool(caller: Caller, name: string, args: Record<string, unknown>, context: RequestContext): Promise<ToolResult>
}

export class DefaultGatewayService implements GatewayService {
  private readonly exchanger: TokenExchanger
  private readonly targetClient: TargetClient
  private readonly targets: TargetConfig[]

  constructor(exchanger: TokenExchanger, targetClient: TargetClient, targets: TargetConfig[]) {
    this.exchanger = exchanger
    this.targetClient = targetClient
    this.targets = targets
  }

  async listTools(caller: Caller, context: RequestContext): Promise<ToolDefinition[]> {
    const perTarget = await Promise.allSettled(
      this.targets.map(async (target): Promise<ToolDefinition[]> => {
        // The caller holds no scope this target uses: nothing would be visible,
        // so the target is not called at all.
        const scopes = scopesForTarget(caller.principal, target)
        if (scopes.length === 0) return []
        const token = await this.tokenFor(caller, target, scopes)
        context.logger.info('target token', { target_id: target.id, exchange: token.cache, scope: scopes.join(' ') })
        const tools = await this.targetClient.listTools(target, this.callContext(token, context))
        return tools
          .filter((tool) => isToolVisible(caller.principal, target, tool.name))
          .map((tool) => ({ ...tool, name: namespacedName(target.id, tool.name) }))
      }),
    )
    // LEARN: A failing target drops out of the catalog instead of failing the
    // whole list, so one broken backend cannot hide every other target's tools.
    return perTarget.flatMap((result, i) => {
      if (result.status === 'fulfilled') return result.value
      context.logger.error('target list failed', { target_id: this.targets[i]?.id, err: result.reason })
      return []
    })
  }

  async callTool(
    caller: Caller,
    name: string,
    args: Record<string, unknown>,
    context: RequestContext,
  ): Promise<ToolResult> {
    const parsed = parseNamespacedName(name)
    const target = parsed && this.targets.find((t) => t.id === parsed.targetId)
    const scope = parsed && target && requiredScope(target, parsed.tool)
    if (!parsed || !target || !scope) return toolError(`Unknown tool ${name}`)

    const missing = missingScope(caller.principal, scope)
    if (missing) {
      context.logger.info('tool call denied', { tool: name, required_scope: missing })
      return toolError(`Tool ${name} requires scope ${missing}`)
    }

    try {
      // Only the one scope this tool needs, even if the caller holds more.
      const token = await this.tokenFor(caller, target, [scope])
      context.logger.info('target token', { target_id: target.id, exchange: token.cache, scope })
      // The target's result, including its own isError results, passes through unchanged.
      return await this.targetClient.callTool(target, this.callContext(token, context), parsed.tool, args)
    } catch (err) {
      if (err instanceof TokenExchangeError) {
        context.logger.error('token exchange failed', { target_id: target.id, tool: name, err })
        return toolError(`Could not authorize the call to target ${target.id}`)
      }
      context.logger.error('target call failed', { target_id: target.id, tool: name, err })
      return toolError(`Target ${target.id} is unavailable`)
    }
  }

  /** A token for exactly this target and these scopes, on behalf of the caller. */
  private tokenFor(caller: Caller, target: TargetConfig, scopes: string[]): Promise<ExchangedToken> {
    return this.exchanger.exchange({
      subjectToken: caller.subjectToken,
      subjectTokenId: caller.principal.tokenId,
      audience: target.audience,
      scopes,
    })
  }

  private callContext(token: ExchangedToken, context: RequestContext) {
    return { accessToken: token.accessToken, traceparent: context.traceparent }
  }
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
