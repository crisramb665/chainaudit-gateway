import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import type { Logger } from "../../core/ports/logger.ts";
import type { ClientRegistry, OAuthClient } from "./clients.ts";
import { NO_STORE, oauthError, type HttpResult } from "./oauth-errors.ts";
import { verifySecret } from "./secret-hash.ts";
import { SIGNING_ALG, type SigningKey } from "./signing-key.ts";

export interface TokenHandlerDeps {
  clients: ClientRegistry;
  signingKey: SigningKey;
  issuer: string;
  audience: string;
  ttlSeconds: number;
  logger: Logger;
}

export interface TokenRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

// Verified against when the client id is unknown, so that path costs the same
// scrypt work as a wrong secret. An all-zero hash that no secret produces.
const DUMMY_HASH = "scrypt$17$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

// LEARN: Unknown client and wrong secret get the same status, message and
// (thanks to DUMMY_HASH) roughly the same latency. Distinct answers would let
// an attacker enumerate valid client ids before attacking their secrets.
const INVALID_CLIENT = oauthError(401, "invalid_client", "Client authentication failed", {
  "WWW-Authenticate": 'Basic realm="chainaudit-token-issuer"',
});

/** POST /oauth2/token, client credentials grant (RFC 6749 §4.4). */
export async function handleTokenRequest(deps: TokenHandlerDeps, req: TokenRequest): Promise<HttpResult> {
  const credentials = parseBasicAuth(req.authorization);
  if (!credentials) return INVALID_CLIENT;

  const client = await authenticate(deps.clients, credentials.clientId, credentials.clientSecret);
  if (!client) {
    deps.logger.info("token denied", { client_id: credentials.clientId, reason: "invalid_client" });
    return INVALID_CLIENT;
  }
  const logger = deps.logger.child({ client_id: client.client_id, tenant_id: client.tenant_id });

  const grantType = req.body.grant_type;
  if (typeof grantType !== "string" || grantType === "") {
    return oauthError(400, "invalid_request", "grant_type is required");
  }
  if (grantType !== "client_credentials") {
    return oauthError(400, "unsupported_grant_type", "Only client_credentials is supported");
  }

  const scopes = resolveScopes(req.body.scope, client.allowed_scopes);
  if (!scopes) {
    logger.info("token denied", { reason: "invalid_scope", requested_scope: req.body.scope });
    return oauthError(400, "invalid_scope", "Requested scope exceeds the scopes allowed for this client");
  }

  const scope = scopes.join(" ");
  const jti = randomUUID();
  const accessToken = await new SignJWT({ tenant_id: client.tenant_id, scope })
    // typ at+jwt (RFC 9068) marks this as an access token, so a verifier can
    // refuse an ID token or any other JWT from the same issuer.
    .setProtectedHeader({ alg: SIGNING_ALG, kid: deps.signingKey.kid, typ: "at+jwt" })
    .setIssuer(deps.issuer)
    // LEARN: The signature proves who issued the token, aud says who it is
    // for. The gateway rejects any token whose aud is not itself, so a token
    // minted for another service (or replayed by one) is useless here. That is
    // what blocks token passthrough and the confused deputy problem.
    .setAudience(deps.audience)
    .setSubject(client.client_id)
    .setIssuedAt()
    // LEARN: A JWT is verified offline and cannot be revoked, so expiry is the
    // only kill switch. 15 minutes bounds how long a leaked token works and how
    // long a scope change takes to apply; clients just ask for a new one.
    .setExpirationTime(`${deps.ttlSeconds}s`)
    .setJti(jti)
    .sign(deps.signingKey.privateKey);

  logger.info("token issued", { jti, scope, expires_in: deps.ttlSeconds });
  return {
    status: 200,
    headers: NO_STORE,
    body: { access_token: accessToken, token_type: "Bearer", expires_in: deps.ttlSeconds, scope },
  };
}

async function authenticate(
  clients: ClientRegistry,
  clientId: string,
  clientSecret: string,
): Promise<OAuthClient | undefined> {
  const client = clients.findClient(clientId);
  const valid = await verifySecret(clientSecret, client?.secret_hash ?? DUMMY_HASH);
  return valid ? client : undefined;
}

// RFC 6749 §2.3.1: id and secret are form-urlencoded before being joined with
// ":" and base64 encoded, so each part is decoded after the split.
function parseBasicAuth(header: string | undefined): { clientId: string; clientSecret: string } | undefined {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!match?.[1]) return undefined;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator <= 0) return undefined;
  try {
    return {
      clientId: formDecode(decoded.slice(0, separator)),
      clientSecret: formDecode(decoded.slice(separator + 1)),
    };
  } catch {
    return undefined; // malformed percent-encoding
  }
}

function formDecode(value: string): string {
  return decodeURIComponent(value.replaceAll("+", " "));
}

/** Granted scopes, or undefined when the request asks for more than allowed. */
function resolveScopes(requested: unknown, allowed: string[]): string[] | undefined {
  if (requested !== undefined && typeof requested !== "string") return undefined;
  const asked = [...new Set((requested ?? "").split(" ").filter(Boolean))];
  // RFC 6749 §3.3: without a scope parameter the server applies a default,
  // here every scope the client is allowed.
  if (asked.length === 0) return allowed;
  return asked.every((scope) => allowed.includes(scope)) ? asked : undefined;
}
