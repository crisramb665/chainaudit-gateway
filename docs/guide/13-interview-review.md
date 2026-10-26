# 13 · Interview review

> Three likely questions per responsibility, each with a 3–5 sentence answer using this repo. **(design only)** marks answers that rely on parts that exist only in the RFC. Chapter numbers point to the detail.

**Roles used in every answer:**
- **Caseware** is the platform operator ("we").
- **Tenants** are the audit firms that are Caseware's customers (`acme`, `globex`).
- **Audit clients** are the companies those firms audit. They're data, not users.

Acronyms used here:
- **MCP**: Model Context Protocol.
- **JWT**: JSON Web Token.
- **JWKS**: JSON Web Key Set.
- **IAM**: Identity and Access Management.
- **STS**: Security Token Service.
- **ABAC**: Attribute Based Access Control.
- **SigV4**: AWS Signature Version 4.
- **SSRF**: Server-Side Request Forgery.
- **SLO**: Service Level Objective.

## 1. AgentCore Gateway layer and its targets (ch. 04, 06)

**Q: What does a gateway in front of MCP servers give you?**
One front door where authentication, tenant isolation, tool catalog merging and failure containment live, instead of every MCP server reimplementing them. In this repo, `src/apps/gateway` merges the tools of every target the caller may use, namespaced as `<target>__<tool>`, and routes each call with the right credential. AgentCore Gateway is the managed version of the same idea. I built the equivalent pieces myself to learn them; I haven't run AgentCore in production.

**Q: What kinds of targets are there, and how do you treat them differently?**
Here there are two kinds: platform targets defined by the operator (the chain MCP server), and tenant targets registered at runtime by a tenant admin. Platform targets are trusted and receive a token minted for them by exchange. Tenant targets are third parties, so they receive only the tenant's API key, are egress-validated on every call, get a 2 s timeout, and are visible only to their own tenant. AgentCore also supports Lambda and OpenAPI targets (verify in AWS docs). Here only MCP targets are built.

**Q: Why filter `tools/list` if every call is checked anyway?**
Filtering gives least privilege at discovery: the model doesn't plan around tools it can't use, and the catalog leaks nothing about other tenants' integrations. But the list is only a view. A client can call any name, stateless requests have no memory of an earlier list, and a token can be narrower at call time. So the check runs again on every `tools/call`, with default deny for anything not in the scope map.

## 2. Tenant target registry (ch. 04, 05)

**Q: How do you make sure one tenant can never see another tenant's targets?**
The tenant comes only from the verified token, never from the request. The registry's partition key is `TENANT#<tenant_id>`, so every read is a Query or GetItem on the caller's own partition. There's no Scan anywhere, and therefore no code path that lists across tenants. Another tenant's target id simply isn't in the caller's list, so it answers "Unknown tool", and tests prove it.

**Q: How are tenant credentials stored and protected?**
The registry stores only a `secret_ref` like `/tenants/acme/targets/notes`. The key itself lives in a per-secret file (`.secrets/`, mode 0600) behind a `CredentialProvider` port, which refuses refs whose tenant differs from the caller's. In AWS, this becomes Secrets Manager with tags and IAM ABAC: the Lambda assumes a role with an STS session tag `tenant_id`, and the policy only allows reading secrets with the same tag (design only). That's stronger, because IAM is enforced outside our process.

**Q: How do you stop a tenant from registering a URL that attacks your internal network?**
The URL must:
- use HTTPS;
- have a hostname, not an IP (any notation, since the URL parser canonicalises them);
- be on the tenant's allowed domains;
- resolve only to public addresses. One private address among public ones fails the whole name.

At call time it's resolved and validated again, and the connection goes to exactly the validated IPs through a pinned lookup, so DNS rebinding has no second answer to exploit. The `Host` header and TLS keep the real hostname.

## 3. Inbound surface for external agents (ch. 03)

**Q: How does an agent authenticate, and what does the gateway check?**
The agent uses OAuth client credentials at the issuer and gets a 15-minute ES256 JWT. The gateway verifies it against the issuer's JWKS (cached, with a cooldown on unknown key ids) and checks:
- the signature, with only ES256 accepted;
- `typ: at+jwt`;
- `iss`;
- `aud = chainaudit-gateway`;
- `exp`;
- the required claims.

Missing or invalid tokens get 401 with a `resource_metadata` pointer, as the MCP authorization spec requires. If the keys can't be fetched, it's 503, our fault rather than the caller's.

**Q: How do scopes work per tool?**
Each platform tool maps to a scope (`get_balance` → `chain:read`), and tenant tools all require `tenant:tools`. The gateway checks the scope before doing anything else for the call: no token exchange, no target call. The MCP server checks again as defence in depth. A tool missing from the map is neither listed nor callable.

**Q: How would you rate-limit agents?** **(design only)**
The RFC designs a token bucket per tenant and per agent client, returning 429 only to that tenant. The open question is what AgentCore Gateway enforces natively. If nothing, the counters go in DynamoDB with a short TTL. Nothing is built yet. The only quota today is max registered targets, enforced with a DynamoDB transaction.

## 4. On-premise connectivity (ch. 07) **(design only)**

**Q: Why does the desktop client connect out instead of the cloud connecting in?** **(design only)**
Customers shouldn't have to open inbound firewall ports or expose a machine with the client's ledger. The desktop opens an outbound WebSocket to API Gateway and keeps it alive, and requests travel down it. A `$connect` authorizer binds the session to `tenant_id` and `device_id`.

**Q: How do you match a response to the request that caused it?** **(design only)**
Every request carries a `correlation_id`, and a pending record in DynamoDB holds status, deadline and TTL. The response can arrive at a different Lambda (the `$default` route) than the one waiting, so it writes the result into that record, and the waiting Lambda polls until the result or the deadline. An ECS service with an in-memory map would be simpler at scale, but isn't serverless.

**Q: What happens when the connection drops?** **(design only)**
Reconnection is normal, because API Gateway closes idle connections after 10 minutes and all connections after 2 hours (per the RFC; verify in AWS docs). The client reconnects with backoff and jitter, presenting `session_id` and its last acknowledged sequence. The server resends pending requests within a 60 s resume window, and the desktop deduplicates by `correlation_id`. Expired requests fail with a retryable `client_offline`, and at most 10 requests are in flight per session (429 beyond).

## 5. Identity and scope propagation across hops (ch. 03)

**Q: Why not forward the agent's token to the MCP server?**
It's addressed to the gateway. Accepting it would mean the MCP server trusts tokens meant for someone else, so any service that ever saw one could replay it. That's token passthrough, which the MCP spec forbids, and the confused deputy problem. Instead the gateway exchanges it (RFC 8693) for a 5-minute token with `aud = chainaudit-mcp`, the agent's `sub` and `tenant_id`, only the one needed scope, and `act = chainaudit-gateway`.

**Q: What stops the gateway from minting tokens with more power?**
The issuer verifies the subject token itself:
- its `aud` must be the gateway;
- it must not already carry `act`;
- the requested scopes must be a subset of the subject's;
- the audience must be on the gateway's allow list.

The new token never outlives the original. Exchange failures surface as a clear tool error, and tests cover each refusal.

**Q: How does this map to AWS?**
Cognito would issue the agent tokens, but the RFC notes it has no `aud` in M2M access tokens and no RFC 8693 exchange (verify in AWS docs). In AWS the gateway-to-target hop would use AgentCore Identity's outbound credentials, with the caller's identity propagated as separate signed context. Calls from targets to AWS backends use SigV4 from an STS session tagged with `tenant_id` (design only).

## 6. OpenAPI contracts and versioning (ch. 09) **(design only)**

**Q: How do you evolve an API without breaking agents?** **(design only)**
Inside a version, only additive changes are allowed: new optional fields and new endpoints. A breaking change ships as `/v2` while `/v1` keeps working with `Deprecation` and `Sunset` headers. A CI job diffs each spec against `main` and fails the build on breaking changes. No specs exist in this repo yet.

**Q: And MCP tools?**
Tool names are stable, new parameters are optional, and a breaking change becomes a new tool name, with the old one kept until usage drops. In the code, tools declare zod input and output schemas, so `structuredContent` is validated by the SDK. Amounts are decimal strings so JSON parsers never round wei.

**Q: Where do contracts live and who owns them?** **(design only)**
The RFC puts one spec per target in the repo, next to its code, so a change and its contract are reviewed together. Tenant targets are third parties, so their contract is whatever their MCP `tools/list` returns. The gateway passes their schemas through unchanged. Ownership and review process beyond that aren't designed.

## 7. Outbound authorization (ch. 03, 04, 06)

**Q: Which credential does each outbound hop use?**
- gateway → platform target: an exchanged JWT for that target;
- gateway → tenant target: the tenant's API key, never a token;
- MCP server → chain: no credential locally (Anvil). The RFC uses the tenant's own provider key from Secrets Manager (design only);
- targets → AWS backends: SigV4 with STS-tagged sessions (design only).

**Q: Why do tenant targets get an API key instead of an OAuth token?**
They're third-party servers. Any token from our issuer, exchanged or not, would let that server call our platform as the agent, which is the confused deputy one hop further. Their own API key is all they need to authenticate us, and it's useless against our platform. Other auth types (OAuth client credentials to the tenant's own issuer) would come via credential providers, like AgentCore Identity's (verify in AWS docs).

**Q: What does the local setup not prove about IAM?** **(design only)**
DynamoDB Local accepts any credentials, and the tenant check on secrets is code, not policy. Whether a role with session tags can read exactly that tenant's secrets, and nothing else, can only be proven in AWS, ideally by trying to read another tenant's secret and seeing AccessDenied. The same goes for SigV4 signing errors.

## 8. Tracing and SLOs (ch. 05, 09)

**Q: How do you trace a request across hops?**
The gateway creates a `trace_id` and sends it as a W3C `traceparent` to every target, and the MCP server and tenant servers continue it. Every JSON log line carries `trace_id`, plus `tenant_id`, `sub` and `act` once known, so one call can be followed by grepping one id. Spans aren't exported yet: Jaeger runs, but OpenTelemetry instrumentation is design only.

**Q: What are your SLOs, and how do you alert?** **(design only)**
Per tenant, over 28 days:
- 99.5% of tool calls without a gateway-caused error;
- sync tool latency p95 under 800 ms, excluding provider time;
- relay round trip p95 under 3 s;
- 99% of final transactions visible within 2 minutes.

Alerts fire on error-budget burn rate, not single failures. None of this is measured yet. Logs have `duration_ms` and typed errors as the starting point.

**Q: How do you keep a tenant's broken server from burning your SLO?**
Target failures are classified separately: timeouts, connection errors and 5xx from a target are the target's fault, and the breaker already distinguishes them from 4xx and from gateway errors. The RFC measures target failures apart from gateway failures (design only). Meanwhile the per-tenant, per-target circuit breaker makes such a target cost its own tenant a fast "circuit open" error, and costs nothing to others.
