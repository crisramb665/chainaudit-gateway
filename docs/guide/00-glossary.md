# 00 · Glossary

Every term used in this repository. Each one has a plain line (what it is, in everyday words), a technical line (what it precisely means), and where it shows up. **Status** says whether the thing is built in this repo, design only (in `docs/rfc-001.md` but no code), or just a general concept.

## Protocols and agents

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **MCP** (Model Context Protocol) | A standard plug that lets an AI agent use tools from any server. | A JSON-RPC based protocol between an MCP client (the agent side) and an MCP server, which exposes *tools*, *resources* and *prompts*. | Everywhere. Built (tools only). |
| **MCP primitives** | The three kinds of things a server can offer. | **Tools**: functions the model can call (`tools/list`, `tools/call`). **Resources**: data the client can read by URI. **Prompts**: reusable prompt templates. This repo uses tools only. | Built: tools. Not used: resources, prompts. |
| **Tool** | One action an agent can ask for, like "get balance". | A named function with a JSON Schema for its input (and optionally its output), listed by `tools/list` and invoked by `tools/call`. | `get_balance`, `get_client_note`. Built. |
| **`tools/list` / `tools/call`** | "What can you do?" / "Do this one." | The two MCP JSON-RPC methods for discovering and invoking tools. | Gateway, MCP server. Built. |
| **`isError`** | A polite "that didn't work, here's why". | A field on an MCP tool result. The call succeeded at the protocol level, but the tool failed, and the text explains it to the model. Different from a JSON-RPC error. | Every tool failure. Built. |
| **Namespacing** | Putting the owner's name in front, like `acme/notes`. | The gateway renames upstream tools to `<target>__<tool>` (e.g. `chain__get_balance`), so tools from different targets never collide. | `src/core/gateway/catalog.ts`. Built. |
| **JSON-RPC** | A simple envelope for "call this function with these arguments". | JSON-RPC 2.0: request `{jsonrpc, id, method, params}`, response `{jsonrpc, id, result}` or `{…, error}`. MCP messages are JSON-RPC. | All MCP traffic. Built. |
| **Streamable HTTP** | MCP over ordinary web requests. | MCP's HTTP transport: the client POSTs JSON-RPC messages to one endpoint, and the server replies with JSON or an SSE (Server-Sent Events) stream. Optional session id. | `/mcp` on every server. Built. |
| **Stateless MCP** | Every request stands alone, like a vending machine. | Streamable HTTP with no session: no `Mcp-Session-Id`, and a new server and transport per request. Any instance can serve any request. | `src/apps/shared/mcp-http-handler.ts`. Built. |
| **SSE** (Server-Sent Events) | A one-way stream from server to client. | A long-lived HTTP response that carries events. This repo disables it (`enableJsonResponse: true`) and answers GET with 405. | Built (disabled on purpose). |

## Identity and authorization

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **OAuth 2.0** | The standard way to get a "visitor badge" for an API. | An authorization framework (RFC 6749): clients obtain access tokens from an authorization server and present them to resource servers. | Issuer. Built (locally). |
| **Client credentials** | A machine logs in with its own id and password, with no human involved. | OAuth grant `client_credentials`: the client authenticates (here with HTTP Basic auth) and receives an access token for itself. | `DefaultTokenIssuer.clientCredentials`. Built. |
| **Token exchange** | Trading your visitor badge for a narrower badge that works for one room only. | OAuth Token Exchange (RFC 8693): a client sends a `subject_token` and gets a new token for another `audience`, often with narrower scope. | `DefaultTokenIssuer.tokenExchange`. Built. |
| **JWT** (JSON Web Token) | A signed note that says who you are and what you may do. | `header.payload.signature`, base64url-encoded. Verifiable offline with the issuer's public key. | All tokens. Built. |
| **`at+jwt`** | A label saying "this note is an access token". | The JWT `typ` header from RFC 9068 (JWT access tokens). Verifiers require it, so an ID token can't pose as an access token. | Signer and verifier. Built. |
| **JWKS** (JSON Web Key Set) | The public list of the issuer's signature stamps. | A JSON document with public keys (`{keys: [...]}`) served at `/.well-known/jwks.json`. Verifiers fetch and cache it. | `JwksHandler`. Built. |
| **`kid`** (key id) | The name tag on a stamp, so you know which stamp to compare against. | A JWT header field that selects the key in the JWKS. Here it's the RFC 7638 thumbprint of the public key. Enables key rotation. | `FileSigningKeyStore`. Built. |
| **ES256** | The signature method. | ECDSA (Elliptic Curve Digital Signature Algorithm) on P-256 with SHA-256. Asymmetric: only the issuer can sign, anyone can verify. | Pinned in `JoseJwtVerifier`. Built. |
| **Audience (`aud`)** | "This badge is for room X." | The JWT claim naming the intended recipient. Every service rejects tokens whose `aud` isn't itself. | `chainaudit-gateway`, `chainaudit-mcp`. Built. |
| **Scope** | The list of things the badge allows. | A space-separated claim (`chain:read tenant:tools`). Checked per tool. | Built. |
| **`sub`** (subject) | Who the badge belongs to. | The JWT claim with the principal's identifier. Here it's the client id (`agent-acme`). | Built. |
| **`jti`** (JWT ID) | A serial number on the badge. | A unique token id, used here as the exchange-cache key and for audit logs. | Built. |
| **`act` claim** | "Carried by: the gateway, on behalf of agent-acme." | The RFC 8693 actor claim, `{ "act": { "sub": "chainaudit-gateway" } }`, recording who acts for the subject. | Exchanged tokens. Built. |
| **Principal** | The verified caller. | In the code, `{ subject, tenantId, scopes, tokenId, expiresAt, actor? }`, built only from a verified token. | `src/core/ports/token-verifier.ts`. Built. |
| **Confused deputy** | A trusted helper tricked into using its own powers for someone who shouldn't have them. | A privileged service misused by a caller, e.g. a gateway that forwards caller tokens, or that calls with its own broad credential. Prevented here by token exchange and audiences. | Chapter 03. Built. |
| **Token passthrough** | Handing your badge to the next person in line. | Forwarding a token received from the caller to a downstream service. Forbidden by the MCP authorization spec. | Not done, on purpose. |
| **PRM** (Protected Resource Metadata) | A sign on the door saying "get your badge over there". | RFC 9728 document at `/.well-known/oauth-protected-resource[/mcp]` naming the authorization server. Referenced from 401 responses. | `resource-metadata.ts`. Built. |
| **scrypt** | A deliberately slow password grinder. | A memory-hard key derivation function. Client secrets are stored as `scrypt$17$8$1$salt$hash`. | `ScryptSecretHasher`. Built. |
| **Constant-time compare** | Checking every letter of the password even after the first mismatch. | Comparing secrets without early exit (`crypto.timingSafeEqual`), so response time reveals nothing. | Scrypt hasher, `ApiKeyGuard`. Built. |
| **IAM** (Identity and Access Management) | AWS's rulebook of who may do what. | Policies attached to roles and users that allow or deny AWS API actions on resources. | Design only. |
| **STS** (Security Token Service) | The AWS desk that hands out temporary badges. | Issues temporary credentials (`AssumeRole`), optionally with session tags. | Design only. |
| **SigV4** (Signature Version 4) | AWS's way of signing every request. | An HMAC (keyed hash) based request signature derived from AWS credentials. Required by AWS APIs. | Design only. Local AWS SDK calls sign with dummy keys against DynamoDB Local. |
| **ABAC** (Attribute Based Access Control) | "You can open drawers with your own name on them." | IAM conditions that compare tags, e.g. allow reading a secret only when its `tenant_id` tag equals the session tag `aws:PrincipalTag/tenant_id`. | Design only (a code check stands in for it). |

## Tenants, targets and egress

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **Platform operator ("we")** | The company that runs the platform: in this scenario, **Caseware**. | Owns the gateway, issuer, MCP server, registry and credential store; defines platform targets and OAuth clients. In this guide "we", "us" and "our platform" always mean the operator. | Everything under `src/apps` except the tenant sample server. Built. |
| **Tenant** | One of Caseware's customers: an **audit or accounting firm**, with walls around its data. | `tenant_id`, taken only from verified token claims. Partitions the registry, credentials and breakers. | `acme`, `globex`. Built. |
| **Audit client** | A company that an audit firm audits: the **firm's** client, not Caseware's. | Not a user of the system; appears only as data (an engagement, a wallet address, a ledger, a client name). | `Northwind Ltd`, `Contoso GmbH` in the sample notes; `engagements` in the SQL lab. |
| **Engagement** | One audit job: "acme audits Northwind for 2026". | A row in `engagements` (`tenant_id`, `client_name`); chain transactions and ledger entries hang off it, never shared across tenants. | SQL lab only. Design only in the apps. |
| **Tenant admin** | The firm's administrator who plugs the firm's own servers in. | An OAuth client of a tenant with scope `registry:admin`. | `acme-admin`, `globex-admin`. Built. |
| **Agent** | The firm's AI assistant that uses the tools. | An OAuth client of a tenant (client credentials), calling the gateway over MCP. | `agent-acme`, `agent-globex`. Built. |
| **Target** | A backend the gateway can route tools to. | `TargetConfig` (platform, from config) or `TenantTarget` (registered by a tenant, from DynamoDB). | Built. |
| **Platform target** | A service Caseware (the operator) runs itself. | Operator-configured (`STATIC_TARGETS`). Trusted, reached with exchanged tokens, not egress-validated. | `chain` → mcp-server. Built. |
| **Tenant target** | A server an audit firm (tenant) runs itself and plugs into Caseware's gateway. | Registered at runtime with `POST /admin/targets`. A third party: API key only, egress validated, its own breaker. | `notes`, `ledger`. Built. |
| **Single-table design** | One filing cabinet, with one drawer per customer. | DynamoDB pattern: different entity types share a table, distinguished by key prefixes (`PK=TENANT#acme`, `SK=CONFIG` or `TARGET#id`). | `chainaudit-registry`. Built. |
| **Query vs. Scan** | Opening one drawer vs. emptying the whole cabinet. | Query reads one partition key (cheap, scoped). Scan reads every item in the table (expensive, crosses tenants). Only Query is used. | Built. |
| **Conditional write** | "Only write this if nobody wrote it before." | A DynamoDB write with a `ConditionExpression` (e.g. `attribute_not_exists(SK)`); it fails atomically if the condition is false. | `createTarget`. Built. |
| **Optimistic concurrency** | "Update only if it's still the version I read." | A version attribute plus the condition `version = :expected`; a lost race fails instead of overwriting. | `updateTargetStatus`. Built. |
| **Idempotency** | Pressing the button twice has the same effect as once. | An operation whose repetition doesn't change the result: re-registering returns the existing target, and `ON CONFLICT DO NOTHING` does the same in SQL. | Registry (built). SQL lab (manual). |
| **SSRF** (Server-Side Request Forgery) | Tricking our server into visiting a place only it can reach. | Making a server send requests to internal addresses (e.g. `169.254.169.254`, the cloud metadata endpoint). | Blocked by `DefaultEgressValidator`. Built. |
| **DNS rebinding** | A street sign that changes after the inspector leaves. | A hostname resolves to a public IP when checked and to a private IP when used. Defeated by connecting to the validated IP. | `pinnedAgent`. Built. |
| **Egress allowlist** | The list of addresses the gateway may visit for a tenant. | `allowed_domains` on the tenant's `CONFIG` item. Exact host or subdomain match. | Built. |
| **IP literal** | Typing a number instead of a street name. | A URL host that is an IP (`127.0.0.1`, `[::1]`, `2130706433`, `0x7f.0.0.1`). Always refused here. | Built. |
| **IPv4-mapped IPv6** | An IPv4 address wearing an IPv6 costume. | `::ffff:a.b.c.d`. It reaches the IPv4 host, so it's refused outright. | `ip-ranges.ts`. Built. |
| **Happy eyeballs** | Trying two doors at once and taking whichever opens. | Racing IPv4 and IPv6 connections. The pinned lookup supports it (`all: true`). | Built. |

## Resilience

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **Timeout** | Hanging up if nobody answers in time. | A limit on how long a call may take. 2 s for providers and tenant targets, 5 s for platform targets. | Built. |
| **Circuit breaker** | A fuse that trips when something keeps failing. | A state machine (closed → open → half-open) that rejects calls to an unhealthy target for a cooldown, then probes. | `src/core/resilience/`. Built. |
| **Half-open probe** | Testing the water with one toe. | After the cooldown, exactly one call is allowed through; its result decides whether the breaker closes or reopens. | Built. |
| **Retry with backoff and jitter** | Trying again, waiting a bit longer each time, at slightly random moments. | Repeating idempotent calls with exponentially growing, randomised delays, to avoid synchronized storms. | Design only. |
| **Bulkhead** | Watertight compartments in a ship. | A cap on concurrent calls per tenant, so one tenant can't exhaust shared capacity. | Design only. |
| **Backpressure** | "We're full, come back later" instead of an endless queue. | Rejecting new work (e.g. 429) when a downstream is saturated. | Design only (relay). |
| **Rate limiting** | A turnstile that lets N people in per minute. | Token bucket per tenant and client, returning 429. | Design only. |
| **Degradation** | Showing yesterday's number, clearly labelled, when today's isn't available. | Returning a last known value with `stale_as_of` instead of failing. | Design only. |
| **Chaos / toxic** | Breaking things on purpose to see the safety nets work. | Toxiproxy *toxics* (latency, down) injected on a proxy via its API (`pnpm chaos`). | Built. |

## Data and async (mostly design only)

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **Outbox** | Writing the letter and the "to send" note in the same notebook entry. | The transactional outbox pattern: the event row is written in the same database transaction as the data, and a publisher sends it later. Avoids the dual-write gap. | Design only. SQL lab ex. 2–3. |
| **At-least-once delivery** | The mail might arrive twice, but it never gets lost. | A queue guarantee (SQS standard queues): consumers must be idempotent. | Design only. |
| **DLQ** (Dead-Letter Queue) | The pile of letters that couldn't be delivered. | A queue receiving messages after N failed processing attempts, with an alarm. | Design only. |
| **`FOR UPDATE SKIP LOCKED`** | Each worker grabs the next free task, skipping ones a colleague is holding. | PostgreSQL row locking that skips rows already locked by other transactions, so workers never take the same job and never wait. | SQL lab ex. 4. |
| **`ON CONFLICT DO NOTHING`** | "If it's already there, skip it quietly." | Insert that silently ignores rows violating a unique constraint. Race-free deduplication. | SQL lab ex. 1. |
| **FULL OUTER JOIN** | Lining up two lists and keeping the rows that have no partner on either side. | A join that keeps unmatched rows from both sides (with NULLs). The core of reconciliation. | SQL lab ex. 5. |
| **Partial index** | An index of only the interesting rows. | `CREATE INDEX … WHERE status = 'pending'`: small and fast for worker queries. | SQL lab ex. 6. |
| **Composite index** | A phone book sorted by last name, then first name. | A multi-column index. Column order decides which queries and sorts it can serve. | SQL lab ex. 6. |
| **Reorg** (chain reorganization) | The blockchain rewriting its last few pages. | Blocks replaced by a competing chain. Transactions in them become orphaned. | Design only. |

## Observability

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **`traceparent`** | A tracking number stuck on the parcel. | The W3C Trace Context header `00-<trace_id>-<span_id>-<flags>`. The gateway creates it, and the MCP server and tenant servers continue it. | `src/apps/shared/trace.ts`. Built (header + logs only). |
| **`trace_id`** | The tracking number itself. | 32 hex chars, present in every JSON log line of a request. | Built. |
| **Span / OpenTelemetry (OTel)** | Timed steps of a parcel's journey. | Spans with parent/child links, exported over OTLP (OpenTelemetry Protocol) to a backend like Jaeger. | Design only (Jaeger runs but receives nothing). |
| **SLO** (Service Level Objective) | A promise like "99.5% of calls work". | A target for a measured indicator over a window (28 days per tenant in the RFC). | Design only. |
| **Error budget** | How many failures the promise allows. | `1 − SLO` of requests in the window. Alerts fire on its burn rate. | Design only. |

## Code structure

| Term | Plain | Technical | Where / status |
| --- | --- | --- | --- |
| **Port** | A socket shape: "anything that fits this can plug in". | An interface in `src/core/ports` that core depends on (e.g. `BalanceReader`, `TenantRegistry`). | Built. |
| **Adapter** | The plug for a specific device. | A class implementing a port with a concrete technology (viem, DynamoDB, jose, files). | `src/adapters/`. Built. |
| **Composition root** | The one place where all the parts get assembled. | `src/apps/<app>/main.ts`: reads config, builds adapters and services, and wires them in dependency order. | Built. |
| **Constructor injection** | Handing each part its tools when you build it. | Dependencies are passed into constructors, typed by interfaces. This makes the fakes in the tests possible. | Built. |
| **Decorator** | A wrapper that adds a feature without changing the thing inside. | A class implementing the same port as the one it wraps (`CachingTokenExchanger`, `CachingTenantTargetReader`). | Built. |
| **Factory** | A machine that builds a fresh item on demand. | An injected object that creates per-request things (`McpServerFactory.create`). | Built. |
| **LEARN comment** | A note for the reader explaining the "why". | `// LEARN:` comments in the code that explain the concept behind a line, not what the line does. | Throughout. |
