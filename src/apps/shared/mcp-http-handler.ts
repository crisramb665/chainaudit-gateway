import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Request, Response } from 'express'
import type { Logger } from '../../core/ports/logger.ts'
import type { Principal } from '../../core/ports/token-verifier.ts'
import type { Authenticator } from './bearer-auth.ts'
import { newTraceId, traceIdFrom, traceparentFor } from './trace.ts'

/** Everything a per-request MCP server needs to know about its request. */
export interface McpRequestContext {
  principal: Principal
  /** The verified bearer token. The gateway exchanges it; it is never forwarded. */
  token: string
  logger: Logger
  /** For outgoing calls made while serving this request. */
  traceparent: string
}

/** The part of the SDK's McpServer / Server this handler uses. */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>
  close(): Promise<void>
}

/** Builds the MCP server for one request. Each app provides its own. */
export interface McpServerFactory {
  create(context: McpRequestContext): ConnectableServer
}

export interface McpHttpHandlerOptions {
  // LEARN: The trace starts at the edge. The gateway ignores an incoming
  // traceparent so callers cannot inject or collide with trace ids; internal
  // services continue the trace they receive, so all hops share one trace_id.
  traceMode: 'start' | 'continue'
}

/** POST /mcp: authenticate, then serve one stateless MCP request. */
export class McpHttpHandler {
  private readonly authenticator: Authenticator
  private readonly factory: McpServerFactory
  private readonly logger: Logger
  private readonly options: McpHttpHandlerOptions

  constructor(authenticator: Authenticator, factory: McpServerFactory, logger: Logger, options: McpHttpHandlerOptions) {
    this.authenticator = authenticator
    this.factory = factory
    this.logger = logger
    this.options = options
  }

  async handle(req: Request, res: Response): Promise<void> {
    const startedAt = performance.now()
    const incoming = this.options.traceMode === 'continue' ? traceIdFrom(req.header('traceparent')) : undefined
    const traceId = incoming ?? newTraceId()
    let logger = this.logger.child({ trace_id: traceId })

    res.on('close', () => {
      logger.info('mcp request', {
        rpc_method: req.body?.method,
        tool: req.body?.params?.name,
        status: res.statusCode,
        duration_ms: Math.round(performance.now() - startedAt),
      })
    })

    // LEARN: Authentication runs before any MCP parsing. Each service accepts
    // only tokens whose aud is itself, so a token addressed to another hop is
    // refused even though the same issuer signed it: no passthrough.
    const auth = await this.authenticator.authenticate(req.header('authorization')).catch((err) => {
      logger.error('authentication failed unexpectedly', { err })
      return { ok: false as const, status: 500, headers: {}, body: { error: 'server_error' }, reason: 'internal' }
    })
    if (!auth.ok) {
      logger.info('request rejected', { status: auth.status, reason: auth.reason })
      res.status(auth.status).set(auth.headers).json(auth.body)
      return
    }
    const { principal } = auth
    // act names the service relaying the call; sub is the original caller.
    logger = logger.child({ tenant_id: principal.tenantId, sub: principal.subject, act: principal.actor })

    // LEARN: A new server and transport for every request is what makes the
    // server stateless. Nothing about one call survives into the next, so any
    // instance (any Lambda) can serve any request without sticky routing. A
    // shared stateless transport would also mix up JSON-RPC ids between
    // concurrent clients; the SDK refuses to handle a second request on one.
    // They are created through the injected factory, the one place that knows
    // which tools this app serves.
    const server = this.factory.create({ principal, token: auth.token, logger, traceparent: traceparentFor(traceId) })
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // no Mcp-Session-Id, no session validation
      enableJsonResponse: true, // plain JSON reply instead of an SSE stream
    })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      logger.error('mcp transport failed', { err })
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null })
      }
    }
  }

  // LEARN: GET opens a long-lived SSE stream for server-initiated messages and
  // DELETE ends a session. A stateless server has neither, and on Lambda a
  // stream would outlive the invocation, so both are refused.
  methodNotAllowed(_req: Request, res: Response): void {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  }
}
