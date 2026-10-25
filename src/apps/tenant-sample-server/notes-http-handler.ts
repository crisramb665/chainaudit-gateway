import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import type { Logger } from '../../core/ports/logger.ts'
import { newTraceId, traceIdFrom } from '../shared/trace.ts'
import type { ConnectableServer } from '../shared/mcp-http-handler.ts'

/** The header this server expects; the tenant registers the key with the platform. */
export const API_KEY_HEADER = 'X-Api-Key'

export interface KeyGuard {
  allows(presented: string | undefined): boolean
}

export interface NotesServerFactory {
  create(): ConnectableServer
}

/** POST /mcp: API key check, then one stateless MCP request. */
export class NotesHttpHandler {
  private readonly guard: KeyGuard
  private readonly factory: NotesServerFactory
  private readonly logger: Logger

  constructor(guard: KeyGuard, factory: NotesServerFactory, logger: Logger) {
    this.guard = guard
    this.factory = factory
    this.logger = logger
  }

  async handle(req: Request, res: Response): Promise<void> {
    const logger = this.logger.child({ trace_id: traceIdFrom(req.header('traceparent')) ?? newTraceId() })
    if (!this.guard.allows(req.header(API_KEY_HEADER))) {
      logger.info('request rejected', { reason: 'invalid api key' })
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid API key' }, id: null })
      return
    }
    const server = this.factory.create()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      logger.info('mcp request', { rpc_method: req.body?.method, tool: req.body?.params?.name, status: res.statusCode })
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    } catch (err) {
      logger.error('mcp transport failed', { err })
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null })
      }
    }
  }

  methodNotAllowed(_req: Request, res: Response): void {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
  }
}
