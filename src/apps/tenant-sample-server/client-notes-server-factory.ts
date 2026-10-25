import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type { NotesServerFactory } from './notes-http-handler.ts'

/** The tenant's own data, as their desktop or back office might hold it. */
const NOTES: Record<string, string> = {
  'northwind ltd': 'Holds treasury in a 2-of-3 multisig; ask for the signer list before year end.',
  'contoso gmbh': 'Moved custody to a new provider in Q3; reconcile the transfer batch of 2026-09-14.',
}

/** Builds the sample tenant MCP server for one request. */
export class ClientNotesServerFactory implements NotesServerFactory {
  create(): McpServer {
    const server = new McpServer({ name: 'acme-client-notes', version: '0.1.0' })
    server.registerTool(
      'get_client_note',
      {
        title: 'Get client note',
        description: "The audit firm's internal note about one of its clients.",
        inputSchema: { client_name: z.string().min(1).max(100) },
        outputSchema: { client_name: z.string(), note: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ client_name }): Promise<CallToolResult> => {
        const note = NOTES[client_name.trim().toLowerCase()]
        if (!note) return { isError: true, content: [{ type: 'text', text: `No note for client ${client_name}` }] }
        const result = { client_name, note }
        return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
      },
    )
    return server
  }
}
