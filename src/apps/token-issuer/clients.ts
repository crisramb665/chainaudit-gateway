import { readFile } from 'node:fs/promises'
import { z } from 'zod'

export const CLIENT_CREDENTIALS = 'client_credentials'
export const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange'

const scopeSchema = z.string().regex(/^\S+$/, 'a scope cannot contain spaces')

const clientSchema = z
  .object({
    client_id: z.string().min(1),
    // Agents belong to one tenant. The gateway has none: it acts for many.
    tenant_id: z.string().min(1).optional(),
    allowed_grant_types: z.array(z.enum([CLIENT_CREDENTIALS, TOKEN_EXCHANGE])).min(1),
    allowed_scopes: z.array(scopeSchema).default([]),
    // Token exchange only: the aud a subject token must have for this client
    // to exchange it, and the audiences it may request.
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

export type OAuthClient = z.infer<typeof clientSchema>

export interface ClientRegistry {
  findClient(clientId: string): OAuthClient | undefined
}

/** Loads and validates the clients file at startup, so a bad file fails fast. */
export async function loadClientRegistry(path: string): Promise<ClientRegistry> {
  const parsed = clientsFileSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  const byId = new Map(parsed.clients.map((client) => [client.client_id, client]))
  return { findClient: (clientId) => byId.get(clientId) }
}
