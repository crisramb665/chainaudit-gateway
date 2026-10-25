import { readFile } from "node:fs/promises";
import { z } from "zod";

const clientSchema = z.object({
  client_id: z.string().min(1),
  tenant_id: z.string().min(1),
  allowed_scopes: z.array(z.string().regex(/^\S+$/, "a scope cannot contain spaces")).min(1),
  secret_hash: z.string().startsWith("scrypt$"),
});

const clientsFileSchema = z.object({ clients: z.array(clientSchema) });

export type OAuthClient = z.infer<typeof clientSchema>;

export interface ClientRegistry {
  findClient(clientId: string): OAuthClient | undefined;
}

/** Loads and validates the clients file at startup, so a bad file fails fast. */
export async function loadClientRegistry(path: string): Promise<ClientRegistry> {
  const parsed = clientsFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const byId = new Map(parsed.clients.map((client) => [client.client_id, client]));
  return { findClient: (clientId) => byId.get(clientId) };
}
