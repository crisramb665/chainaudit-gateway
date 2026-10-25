import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import type { GatewayService } from '../../core/gateway/gateway-service.ts'
import type { McpRequestContext, McpServerFactory } from '../shared/mcp-http-handler.ts'

/** Builds the gateway's MCP server for one request; routing and policy live in GatewayService. */
export class GatewayServerFactory implements McpServerFactory {
  private readonly gateway: GatewayService

  constructor(gateway: GatewayService) {
    this.gateway = gateway
  }

  // The low-level Server is used because upstream tools arrive with JSON
  // Schemas already built; McpServer.registerTool expects zod schemas.
  create({ principal, token, logger, traceparent }: McpRequestContext): Server {
    const server = new Server({ name: 'chainaudit-gateway', version: '0.1.0' }, { capabilities: { tools: {} } })
    const caller = { principal, subjectToken: token }
    const context = { traceparent, logger }

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: (await this.gateway.listTools(caller, context)) as Tool[],
    }))

    server.setRequestHandler(
      CallToolRequestSchema,
      async (request) =>
        (await this.gateway.callTool(
          caller,
          request.params.name,
          request.params.arguments ?? {},
          context,
        )) as CallToolResult,
    )

    return server
  }
}
