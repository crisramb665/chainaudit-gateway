import { randomUUID } from 'node:crypto'
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Request, Response } from 'express'
import { createJsonLogger } from '../../adapters/local/json-logger.ts'
import { createViemBalanceReader } from '../../adapters/local/viem-balance-reader.ts'
import { loadConfig } from './config.ts'
import { buildMcpServer } from './server.ts'

const HOST = '127.0.0.1'
const config = loadConfig()
const rootLogger = createJsonLogger({ service: 'mcp-server' })

// LEARN: Process-wide resources (the RPC client and its connection pool) are
// created once and shared. Only MCP protocol state is per request. Stateless
// is about the protocol, not about rebuilding everything on every call.
const balanceReader = createViemBalanceReader({ rpcUrl: config.RPC_URL, timeoutMs: config.RPC_TIMEOUT_MS })

// Parses JSON and, because HOST is loopback, rejects requests whose Host
// header is not localhost (DNS rebinding protection).
const app = createMcpExpressApp({ host: HOST })

app.post('/mcp', async (req: Request, res: Response) => {
  const startedAt = performance.now()
  const logger = rootLogger.child({ trace_id: traceIdFrom(req) })

  // LEARN: A new server and transport for every request is what makes the
  // server stateless. Nothing about one call survives into the next, so any
  // instance (any Lambda) can serve any request without sticky routing. A
  // shared stateless transport would also mix up JSON-RPC ids between
  // concurrent clients; the SDK refuses to handle a second request on one.
  const server = buildMcpServer({ balanceReader, logger })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // no Mcp-Session-Id, no session validation
    enableJsonResponse: true, // plain JSON reply instead of an SSE stream
  })

  res.on('close', () => {
    logger.info('mcp request', {
      rpc_method: req.body?.method,
      status: res.statusCode,
      duration_ms: Math.round(performance.now() - startedAt),
    })
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
})

// LEARN: GET opens a long-lived SSE stream for server-initiated messages and
// DELETE ends a session. A stateless server has neither, and on Lambda a
// stream would outlive the invocation, so both are refused.
app.all('/mcp', (_req: Request, res: Response) => {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null })
})

app.listen(config.MCP_PORT, HOST, (err?: Error) => {
  if (err) {
    rootLogger.error('mcp server failed to start', { err })
    process.exit(1)
  }
  rootLogger.info('mcp server listening', { host: HOST, port: config.MCP_PORT, rpc_url: config.RPC_URL })
})

// Reuses the trace id from a W3C traceparent header (00-<trace>-<span>-<flags>)
// so a call can be followed across hops; otherwise starts a new trace.
function traceIdFrom(req: Request): string {
  const match = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(req.header('traceparent') ?? '')
  return match?.[1] ?? randomUUID().replaceAll('-', '')
}
