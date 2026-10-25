import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import {
  CLIENT_CREDENTIALS,
  TOKEN_EXCHANGE,
  type ClientRegistry,
  type OAuthClient,
} from '../../core/ports/client-registry.ts'

const scopeSchema = z.string().regex(/^\S+$/, 'a scope cannot contain spaces')

const clientSchema = z
  .object({
    client_id: z.string().min(1),
    tenant_id: z.string().min(1).optional(),
    allowed_grant_types: z.array(z.enum([CLIENT_CREDENTIALS, TOKEN_EXCHANGE])).min(1),
    allowed_scopes: z.array(scopeSchema).default([]),
    subject_audience: z.string().min(1).optional(),
    allowed_audiences: z.array(z.string().min(1)).optional(),
    secret_hash: z.string().startsWith('scrypt$'),
  })
  .superRefine((client, ctx) => {
    const grants = client.allowed_grant_types
    if (grants.includes(CLIENT_CREDENTIALS) && (!client.tenant_id || client.allowed_scopes.length === 0)) {
      ctx.addIssue({ code: 'custom', message: `${client.client_id}: client_credentials needs tenant_id and scopes` })
    }
    if (grants.includes(TOKEN_EXCHANGE) && (!client.subject_audience || !client.allowed_audiences?.length)) {
      ctx.addIssue({
        code: 'custom',
        message: `${client.client_id}: token exchange needs subject_audience and allowed_audiences`,
      })
    }
  })

const clientsFileSchema = z.object({ clients: z.array(clientSchema) })

/** OAuth clients from a JSON file, validated once at startup so a bad file fails fast. */
export class JsonFileClientRegistry implements ClientRegistry {
  static async load(path: string): Promise<JsonFileClientRegistry> {
    const parsed = clientsFileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    return new JsonFileClientRegistry(parsed.clients)
  }

  private readonly byId: Map<string, OAuthClient>

  constructor(clients: OAuthClient[]) {
    this.byId = new Map(clients.map((client) => [client.client_id, client]))
  }

  findClient(clientId: string): OAuthClient | undefined {
    return this.byId.get(clientId)
  }
}
