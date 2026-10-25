import type { EgressValidator } from '../egress/egress-validator.ts'
import { CircuitOpenError, TokenExchangeError } from '../errors.ts'
import type { CredentialProvider } from '../ports/credential-provider.ts'
import type { Logger } from '../ports/logger.ts'
import type { TargetClient, TargetCredential, ToolDefinition, ToolResult } from '../ports/target-client.ts'
import type { TenantTarget, TenantTargetReader } from '../ports/tenant-registry.ts'
import type { TokenExchanger } from '../ports/token-exchanger.ts'
import type { Principal } from '../ports/token-verifier.ts'
import type { TargetBreakers } from '../resilience/circuit-breakers.ts'
import {
  TENANT_TOOLS_SCOPE,
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

export interface GatewayOptions {
  /** Timeout for calls to tenant targets (third parties). Platform targets use the client's default. */
  tenantTargetTimeoutMs: number
}

/** What the gateway's MCP layer needs from core. */
export interface GatewayService {
  listTools(caller: Caller, context: RequestContext): Promise<ToolDefinition[]>
  callTool(caller: Caller, name: string, args: Record<string, unknown>, context: RequestContext): Promise<ToolResult>
}

export class DefaultGatewayService implements GatewayService {
  private readonly exchanger: TokenExchanger
  private readonly targetClient: TargetClient
  private readonly platformTargets: TargetConfig[]
  private readonly tenantTargets: TenantTargetReader
  private readonly credentials: CredentialProvider
  private readonly egress: EgressValidator
  private readonly breakers: TargetBreakers
  private readonly options: GatewayOptions

  constructor(
    exchanger: TokenExchanger,
    targetClient: TargetClient,
    platformTargets: TargetConfig[],
    tenantTargets: TenantTargetReader,
    credentials: CredentialProvider,
    egress: EgressValidator,
    breakers: TargetBreakers,
    options: GatewayOptions,
  ) {
    this.exchanger = exchanger
    this.targetClient = targetClient
    // LEARN: Platform targets come from operator config, reviewed and deployed
    // like code, so they are trusted and skip egress validation. Tenant targets
    // are user input and are validated on every single call.
    this.platformTargets = platformTargets
    this.tenantTargets = tenantTargets
    this.credentials = credentials
    this.egress = egress
    this.breakers = breakers
    this.options = options
  }

  async listTools(caller: Caller, context: RequestContext): Promise<ToolDefinition[]> {
    const platform = this.platformTargets.map((target) => ({
      id: target.id,
      list: () => this.listPlatformTools(caller, target, context),
    }))
    const tenant = (await this.ownTenantTargets(caller, context)).map((target) => ({
      id: target.targetId,
      list: () => this.listTenantTools(caller, target, context),
    }))
    const perTarget = await Promise.allSettled([...platform, ...tenant].map((t) => t.list()))
    const ids = [...platform, ...tenant].map((t) => t.id)
    // LEARN: A failing target drops out of the catalog instead of failing the
    // whole list, so one broken backend cannot hide every other target's tools.
    return perTarget.flatMap((result, i) => {
      if (result.status === 'fulfilled') return result.value
      context.logger.error('target list failed', { target_id: ids[i], err: result.reason })
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
    if (!parsed) return toolError(`Unknown tool ${name}`)
    const platform = this.platformTargets.find((t) => t.id === parsed.targetId)
    if (platform) return this.callPlatformTool(caller, platform, parsed.tool, name, args, context)

    // Looked up among the caller's own tenant's targets only: another tenant's
    // target ids are simply not in this list, so they answer "Unknown tool".
    const tenantTarget = (await this.tenantTargetsOf(caller, context)).find((t) => t.targetId === parsed.targetId)
    if (!tenantTarget) return toolError(`Unknown tool ${name}`)
    const missing = missingScope(caller.principal, TENANT_TOOLS_SCOPE)
    if (missing) {
      context.logger.info('tool call denied', { tool: name, required_scope: missing })
      return toolError(`Tool ${name} requires scope ${missing}`)
    }

    const connectTo = await this.egressFor(caller, tenantTarget, context)
    if (!connectTo) return toolError(`Target ${tenantTarget.targetId} failed egress validation`)

    let credential: TargetCredential
    try {
      credential = await this.tenantCredential(caller, tenantTarget)
    } catch (err) {
      context.logger.error('tenant credential unavailable', { target_id: tenantTarget.targetId, tool: name, err })
      return toolError(`Could not authorize the call to target ${tenantTarget.targetId}`)
    }
    try {
      return await this.breakers.run(caller.principal.tenantId, tenantTarget.targetId, context.logger, () =>
        this.targetClient.callTool(
          { id: tenantTarget.targetId, url: tenantTarget.baseUrl },
          { credential, traceparent: context.traceparent, connectTo, timeoutMs: this.options.tenantTargetTimeoutMs },
          parsed.tool,
          args,
        ),
      )
    } catch (err) {
      if (err instanceof CircuitOpenError) return circuitOpen(tenantTarget.targetId)
      context.logger.error('target call failed', { target_id: tenantTarget.targetId, tool: name, err })
      return toolError(`Target ${tenantTarget.targetId} is unavailable`)
    }
  }

  private async listPlatformTools(
    caller: Caller,
    target: TargetConfig,
    context: RequestContext,
  ): Promise<ToolDefinition[]> {
    // The caller holds no scope this target uses: nothing would be visible,
    // so the target is not called at all.
    const scopes = scopesForTarget(caller.principal, target)
    if (scopes.length === 0) return []
    const credential = await this.platformCredential(caller, target, scopes, context)
    const tools = await this.breakers.run(caller.principal.tenantId, target.id, context.logger, () =>
      this.targetClient.listTools(target, { credential, traceparent: context.traceparent }),
    )
    return tools
      .filter((tool) => isToolVisible(caller.principal, target, tool.name))
      .map((tool) => ({ ...tool, name: namespacedName(target.id, tool.name) }))
  }

  private async listTenantTools(
    caller: Caller,
    target: TenantTarget,
    context: RequestContext,
  ): Promise<ToolDefinition[]> {
    const connectTo = await this.egressFor(caller, target, context)
    if (!connectTo) throw new Error(`target ${target.targetId} failed egress validation`)
    const credential = await this.tenantCredential(caller, target)
    const tools = await this.breakers.run(caller.principal.tenantId, target.targetId, context.logger, () =>
      this.targetClient.listTools(
        { id: target.targetId, url: target.baseUrl },
        { credential, traceparent: context.traceparent, connectTo, timeoutMs: this.options.tenantTargetTimeoutMs },
      ),
    )
    return tools.map((tool) => ({ ...tool, name: namespacedName(target.targetId, tool.name) }))
  }

  private async callPlatformTool(
    caller: Caller,
    target: TargetConfig,
    tool: string,
    name: string,
    args: Record<string, unknown>,
    context: RequestContext,
  ): Promise<ToolResult> {
    const scope = requiredScope(target, tool)
    if (!scope) return toolError(`Unknown tool ${name}`)
    const missing = missingScope(caller.principal, scope)
    if (missing) {
      context.logger.info('tool call denied', { tool: name, required_scope: missing })
      return toolError(`Tool ${name} requires scope ${missing}`)
    }

    try {
      // Only the one scope this tool needs, even if the caller holds more.
      const credential = await this.platformCredential(caller, target, [scope], context)
      // The target's result, including its own isError results, passes through unchanged.
      return await this.breakers.run(caller.principal.tenantId, target.id, context.logger, () =>
        this.targetClient.callTool(target, { credential, traceparent: context.traceparent }, tool, args),
      )
    } catch (err) {
      if (err instanceof CircuitOpenError) return circuitOpen(target.id)
      if (err instanceof TokenExchangeError) {
        context.logger.error('token exchange failed', { target_id: target.id, tool: name, err })
        return toolError(`Could not authorize the call to target ${target.id}`)
      }
      context.logger.error('target call failed', { target_id: target.id, tool: name, err })
      return toolError(`Target ${target.id} is unavailable`)
    }
  }

  /** A token for exactly this platform target and these scopes, on behalf of the caller. */
  private async platformCredential(
    caller: Caller,
    target: TargetConfig,
    scopes: string[],
    context: RequestContext,
  ): Promise<TargetCredential> {
    const token = await this.exchanger.exchange({
      subjectToken: caller.subjectToken,
      subjectTokenId: caller.principal.tokenId,
      audience: target.audience,
      scopes,
    })
    context.logger.info('target token', { target_id: target.id, exchange: token.cache, scope: scopes.join(' ') })
    return { kind: 'bearer', token: token.accessToken }
  }

  // LEARN: A tenant target is a third party's server. It gets the tenant's own
  // API key and nothing else: never the agent token and never a token minted
  // by our issuer, because any of those would let that server call our
  // platform as the agent (the confused deputy again, one hop further).
  private async tenantCredential(caller: Caller, target: TenantTarget): Promise<TargetCredential> {
    return { kind: 'api_key', key: await this.credentials.getSecret(caller.principal, target.secretRef) }
  }

  // LEARN: Validating again at call time, and handing the client the exact
  // addresses we validated, is what defeats DNS rebinding. The tenant's DNS can
  // answer a public IP at registration (or to our check) and a private one a
  // second later; if the HTTP client resolved the name again on its own, the
  // check and the connection could see different answers. Here they cannot.
  /** The addresses this tenant target may be reached on right now, or undefined when it must not be called. */
  private async egressFor(
    caller: Caller,
    target: TenantTarget,
    context: RequestContext,
  ): Promise<string[] | undefined> {
    const settings = await this.tenantTargets.getTenantSettings(caller.principal.tenantId)
    const result = await this.egress.validate(target.baseUrl, settings?.allowedDomains ?? [])
    if (!result.ok) {
      context.logger.error('egress validation failed', { target_id: target.targetId, reason: result.reason })
      return undefined
    }
    context.logger.info('egress validated', { target_id: target.targetId, connect_to: result.addresses })
    return result.addresses
  }

  /** The caller's tenant targets, when the caller may use them at all. */
  private async ownTenantTargets(caller: Caller, context: RequestContext): Promise<TenantTarget[]> {
    if (missingScope(caller.principal, TENANT_TOOLS_SCOPE)) return []
    return this.tenantTargetsOf(caller, context)
  }

  private async tenantTargetsOf(caller: Caller, context: RequestContext): Promise<TenantTarget[]> {
    try {
      // The tenant comes from the verified principal, never from the request.
      return await this.tenantTargets.listActiveTargets(caller.principal.tenantId)
    } catch (err) {
      context.logger.error('tenant targets unavailable', { err })
      return []
    }
  }
}

function circuitOpen(targetId: string): ToolResult {
  return toolError(`Target ${targetId} is temporarily unavailable (circuit open)`)
}

function toolError(message: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}
