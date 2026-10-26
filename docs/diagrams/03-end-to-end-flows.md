# 03 · End-to-end flows, with names

A snapshot drawn from the code after task 6 (commit `0ae1470`, plus the guide). Every name, port, log line and response text is taken from the source. Design-only parts are dashed and labelled. Earlier snapshots (01, 02) stay as they were.

**Cast**

| Name | Role | Where it lives |
| --- | --- | --- |
| **Caseware** | Platform operator ("we"). Runs everything in `src/apps` except the tenant sample servers | gateway :3000, token-issuer :3002, mcp-server :3001, DynamoDB :8000, `.secrets/`, `.keys/` |
| **acme** | Audit firm, Caseware customer, tenant `acme` | `TENANT#acme` partition, clients `agent-acme` and `acme-admin`, its own server `notes` (:3003 via Toxiproxy :13003) |
| **globex** | Another audit firm, tenant `globex` | `TENANT#globex`, clients `agent-globex` and `globex-admin`, its own server `ledger` (:3004) |
| **Northwind Ltd** | acme's audit client (data, not a user) | A wallet on Anvil (illustrated by account #1, `0x7099…79C8`), a note in acme's `notes` server |
| **agent-acme** | acme's AI agent | `clients.json`: scopes `chain:read recon:read recon:write tenant:tools` |
| **acme-admin** | acme's administrator | `clients.json`: scope `registry:admin` |
| **chainaudit-gateway** | The gateway's own OAuth client | Token exchange only, audiences `[chainaudit-mcp]` |

Contents:

1. Who's who and where everything runs
2. Startup and wiring
3. Caseware onboards a tenant
4. Token issuance, every branch
5. Token exchange inside the issuer
6. Inside the gateway, one request
7. agent-acme lists its tools
8. agent-acme reads Northwind's wallet balance
9. agent-acme reads acme's note about Northwind
10. acme-admin registers `notes`
11. The life of a registry item
12. Isolation scenarios
13. A DNS rebinding attack
14. The breaker during the chaos demo
15. Error map
16. Northwind's reconciliation (design only)

---

## 1. Who's who and where everything runs

**What you're looking at:** three organisational layers and every running process, with its port, and who owns it. The right-hand column shows the AWS services each piece stands in for (design only, dashed).

```mermaid
flowchart LR
  subgraph caseware["Caseware: platform operator (built, local)"]
    gw["gateway :3000<br/>POST /mcp, POST /admin/targets,<br/>/.well-known/oauth-protected-resource"]
    iss["token-issuer :3002<br/>POST /oauth2/token, /.well-known/jwks.json<br/>.keys/token-issuer-es256.json"]
    mcp["mcp-server :3001<br/>tool get_balance"]
    ddb[("DynamoDB Local :8000<br/>table chainaudit-registry")]
    sec[(".secrets/tenants/…<br/>tenant API keys, mode 600")]
    toxi["Toxiproxy :8474 API<br/>anvil :18545, acme-notes :13003"]
    anvil["Anvil :8545<br/>chain id 31337"]
  end

  subgraph acme["acme: audit firm, tenant acme"]
    aa(["agent-acme"])
    ad(["acme-admin"])
    an["acme's server 'notes'<br/>tenant-sample-server :3003<br/>X-Api-Key acme-sample-key"]
  end

  subgraph globex["globex: audit firm, tenant globex"]
    ga(["agent-globex"])
    gd(["globex-admin"])
    gl["globex's server 'ledger'<br/>tenant-sample-server :3004<br/>X-Api-Key globex-sample-key"]
  end

  subgraph clients["acme's audit clients (data only)"]
    nw["Northwind Ltd<br/>wallet on Anvil, note in 'notes'"]
  end

  subgraph aws["AWS equivalents (design only)"]
    ac["AgentCore Gateway"]
    cog["Cognito"]
    lam["Lambda"]
    sm[("Secrets Manager + ABAC")]
    dyn[("DynamoDB")]
  end

  aa --> gw
  ga --> gw
  ad --> gw
  gd --> gw
  aa --> iss
  ad --> iss
  gw --> iss
  gw --> mcp
  gw --> ddb
  gw --> sec
  gw --> toxi
  gw --> gl
  toxi --> an
  mcp --> toxi
  toxi --> anvil
  nw -.- anvil
  nw -.- an
  gw -.->|design only| ac
  iss -.->|design only| cog
  mcp -.->|design only| lam
  sec -.->|design only| sm
  ddb -.->|design only| dyn

  classDef design stroke-dasharray: 5 5,color:#777
  class ac,cog,lam,sm,dyn design
```

- **Caseware's** box holds everything the operator runs. acme and globex never touch DynamoDB, `.secrets/` or the issuer's keys directly.
- **acme's** and **globex's** boxes hold their identities (OAuth clients defined in `src/apps/token-issuer/clients.json`) and the servers they run themselves.
- **Northwind** has no identity in the system. It shows up only as data: a wallet address and a note.

---

## 2. Startup and wiring

**What you're looking at:** the commands in order (all from `package.json`), what each composition root (`main.ts`) does when it starts, and the line it prints.

```mermaid
sequenceDiagram
  autonumber
  participant Y as you (terminal)
  participant DK as Docker
  participant S as scripts
  participant I as token-issuer
  participant M as mcp-server
  participant TS as tenant-sample-server
  participant G as gateway

  Y->>DK: pnpm infra:up
  DK-->>Y: anvil, toxiproxy, dynamodb, postgres, jaeger running (anvil and postgres healthy)
  Y->>S: pnpm setup:dynamodb
  S->>DK: CreateTable chainaudit-registry, Update CONFIG for acme and globex
  S-->>Y: table chainaudit-registry created, CONFIG for acme: max_targets 3, allowed_domains localhost
  Y->>S: pnpm seed:anvil
  S->>DK: 5 transfers on Anvil :8545 (direct, not through Toxiproxy)
  S-->>Y: one line per transfer (account 0 to account 1, 1 ETH, block, tx hash), then balances
  Y->>I: pnpm issuer:dev
  I->>I: parseConfig, FileSigningKeyStore.loadOrCreate(.keys/…), JsonFileClientRegistry.load(clients.json)
  I-->>Y: token issuer listening, port 3002, kid
  Y->>M: pnpm mcp:dev
  M->>M: parseConfig, ViemBalanceReader(:18545, 2 s), JoseJwtVerifier(remote JWKS, not fetched yet)
  M-->>Y: mcp server listening, port 3001, audience chainaudit-mcp
  Y->>TS: pnpm tenant-sample:dev (and tenant-sample-globex:dev)
  TS-->>Y: tenant sample server listening, port 3003 (3004)
  Y->>G: pnpm gateway:dev (APP_ENV=local EGRESS_ALLOW_PRIVATE_NETWORKS=true)
  G->>G: parseConfig, build adapters, core services, handlers, routes
  G-->>Y: warn egress: private networks allowed for tenant targets (APP_ENV=local)
  G-->>Y: gateway listening, port 3000, targets chain, registry chainaudit-registry, app_env local
  Note over G,M: JWKS are fetched lazily, on the first token verification, then cached (10 min, 30 s cooldown)
```

1. `pnpm infra:up` runs `docker compose -f infra/docker-compose.yml up -d`.
2. Five containers start. Healthchecks: `pg_isready` and `cast block-number`. `pnpm infra:ps` shows the status.
3. `pnpm setup:dynamodb` runs `scripts/setup-dynamodb.ts`.
4. `CreateTableCommand` (PK/SK, on demand), then `UpdateCommand` per tenant `CONFIG` (`target_count` initialised, never reset).
5. Its console output. DynamoDB Local is in memory, so this is rerun after every `infra:up`.
6. `pnpm seed:anvil` runs `scripts/seed-anvil.ts`, using Anvil's public dev mnemonic.
7. Five `sendTransaction` calls, waiting for each receipt.
8. Tx hashes and final balances. Anvil is in memory too.
9. `pnpm issuer:dev` runs `src/apps/token-issuer/main.ts`.
10. If the key file is missing it generates ES256 and writes it with mode 0600. `clients.json` is validated with zod, and a bad file stops startup.
11. Log line `token issuer listening` (with `kid`).
12. `pnpm mcp:dev` runs `src/apps/mcp-server/main.ts`.
13. Adapters, `DefaultBalanceService`, `AudienceTokenVerifier(aud chainaudit-mcp)`, `ChainToolsServerFactory`, `McpHttpHandler(traceMode continue)`.
14. Log line `mcp server listening`.
15. `pnpm tenant-sample:dev` / `tenant-sample-globex:dev` run `src/apps/tenant-sample-server/main.ts` with `SAMPLE_PORT` and `SAMPLE_API_KEY`.
16. Log line `tenant sample server listening`.
17. `pnpm gateway:dev` runs `src/apps/gateway/main.ts`. The env flags come from the script.
18. The wiring order is in the file's numbered comments: config → adapters → core → driving side → routes.
19. Printed only when local mode is on. In production the flag is never read.
20. Log line `gateway listening`.

---

## 3. Caseware onboards a tenant

**What you're looking at:** what Caseware (the operator) does so a new audit firm can use the platform. Today it's all manual. Dashed steps are what a production onboarding API would do (design only).

```mermaid
flowchart TD
  start(["Caseware signs a new audit firm, e.g. acme"]) --> c1["1. Tenant settings: CONFIG item<br/>PK TENANT#acme, SK CONFIG<br/>max_targets 3, allowed_domains [localhost], target_count 0"]
  c1 -->|"today: scripts/setup-dynamodb.ts"| c2["2. OAuth clients for the firm<br/>agent-acme (tool scopes)<br/>acme-admin (registry:admin)"]
  c2 -->|"today: pnpm hash-secret secret, paste hash into clients.json"| c3["3. Restart token-issuer to load clients.json"]
  c3 --> c4["4. acme-admin can now register acme's own servers<br/>(flow 10), agent-acme can call tools (flows 7 to 9)"]
  c1 -.->|design only| d1["Onboarding API with review of allowed_domains"]
  c2 -.->|design only| d2["Cognito app clients + resource server scopes<br/>tenant_id via pre-token-generation trigger (verify in AWS docs)"]
  classDef design stroke-dasharray: 5 5,color:#777
  class d1,d2 design
```

- `scripts/setup-dynamodb.ts` holds the tenant list in code: acme with `max_targets 3` and globex with `max_targets 1`, both with `allowed_domains [localhost]`.
- `scripts/hash-secret.ts` prints `scrypt$17$8$1$<salt>$<hash>` via `ScryptSecretHasher.hash`.
- `clients.json` is loaded once at startup (`JsonFileClientRegistry.load`).

---

## 4. Token issuance, every branch

**What you're looking at:** agent-acme asking for a token, and every answer the issuer can give.

```mermaid
sequenceDiagram
  autonumber
  participant A as agent-acme
  participant H as TokenEndpointHandler
  participant T as DefaultTokenIssuer
  participant R as JsonFileClientRegistry
  participant S as ScryptSecretHasher
  participant K as JoseAccessTokenSigner

  A->>H: POST /oauth2/token Basic agent-acme:acme-local-secret, grant_type=client_credentials, scope=chain:read
  alt no or malformed Basic header
    H-->>A: 401 invalid_client Client authentication failed, WWW-Authenticate Basic
  end
  H->>T: issue(clientId, clientSecret, params)
  T->>R: findClient(agent-acme)
  R-->>T: client (or undefined)
  T->>S: verify(secret, hash or undefined)
  Note over S: unknown client: same scrypt work against a dummy hash
  alt unknown client or wrong secret
    T-->>A: 401 invalid_client Client authentication failed (same text for both)
  else grant_type missing
    T-->>A: 400 invalid_request grant_type is required
  else grant_type not supported
    T-->>A: 400 unsupported_grant_type Unsupported grant_type password
  else grant not allowed for this client
    T-->>A: 400 unauthorized_client This client may not use this grant type
  else scope not allowed
    T-->>A: 400 invalid_scope Requested scope exceeds the scopes allowed for this client
  end
  T->>K: sign aud chainaudit-gateway, sub agent-acme, tenant_id acme, scope, iat, exp iat+900
  K-->>T: JWT with header alg ES256, kid, typ at+jwt, and a new jti
  T-->>H: ok body
  H-->>A: 200 access_token, token_type Bearer, expires_in 900, scope, Cache-Control no-store
```

1. The `src/apps/token-issuer/main.ts` route (`express.urlencoded`) → `TokenEndpointHandler.handle`.
2. `parseBasicAuth` (form-decoding per RFC 6749 §2.3.1) fails → `oauthError(401, 'invalid_client', …, BASIC_CHALLENGE)`.
3. `DefaultTokenIssuer.issue` (`src/core/issuer/token-issuer.ts`).
4. `JsonFileClientRegistry.findClient`.
5. Returns the client or `undefined`.
6. `ScryptSecretHasher.verify` (`timingSafeEqual`; `DUMMY_HASH` when the client is unknown).
7. `INVALID_CLIENT` → `toHttp` → 401 + `WWW-Authenticate Basic`. Logged as `token denied`, `reason invalid_client`.
8. `fail('invalid_request', 'grant_type is required')`.
9. `fail('unsupported_grant_type', …)`.
10. `fail('unauthorized_client', …)`, logged as `token denied`.
11. `clientCredentials` → `resolveScopes` returns undefined → `fail('invalid_scope', …)`. No scope requested means all allowed scopes.
12. `JoseAccessTokenSigner.sign`, with `exp = issuedAt + TOKEN_TTL_SECONDS (900)`.
13. The JWT, signed with the key from `.keys/`, with a `jti` from `randomUUID`.
14. Log line `token issued` with `jti`, `scope`, `expires_in`, `client_id`, `tenant_id`.
15. `toHttp` → 200 with `Cache-Control no-store` and `Pragma no-cache`.

---

## 5. Token exchange inside the issuer

**What you're looking at:** the gateway trading agent-acme's token for one addressed to the MCP server, with every check in order. Each refusal is a 400 with the `error` shown.

```mermaid
flowchart TD
  r(["POST /oauth2/token<br/>Basic chainaudit-gateway:gateway-local-secret<br/>grant_type token-exchange, subject_token agent-acme's JWT,<br/>audience chainaudit-mcp, scope chain:read"]) --> a{"client authenticated?"}
  a -- no --> e0["401 invalid_client"]
  a -- yes --> b{"token-exchange in the client's allowed_grant_types?"}
  b -- "no (e.g. agent-acme tries)" --> e1["400 unauthorized_client"]
  b -- yes --> c{"subject_token present, subject_token_type = access_token,<br/>requested_token_type absent or access_token?"}
  c -- no --> e2["400 invalid_request"]
  c -- yes --> d{"audience present and in allowed_audiences [chainaudit-mcp]?"}
  d -- no --> e3["400 invalid_target"]
  d -- yes --> f{"subject token valid: ES256, typ at+jwt, iss,<br/>aud = subject_audience chainaudit-gateway, no act claim?"}
  f -- "no (e.g. re-exchanging an exchanged token)" --> e4["400 invalid_request subject token is invalid"]
  f -- yes --> g{"scope present and a subset of the subject's scopes?"}
  g -- "missing" --> e5["400 invalid_request scope is required"]
  g -- "not a subset (e.g. recon:write for agent-globex)" --> e6["400 invalid_scope"]
  g -- yes --> h["sign: aud chainaudit-mcp, sub agent-acme, tenant_id acme,<br/>scope chain:read, act sub chainaudit-gateway,<br/>exp = min(now + 300, subject exp)"]
  h --> ok(["200 access_token, issued_token_type access_token,<br/>expires_in up to 300, scope chain:read<br/>log: token exchanged"])
```

- `DefaultTokenIssuer.issue` handles the grant checks; `tokenExchange` and `verifySubject` (`src/core/issuer/token-issuer.ts`) do the rest.
- Subject tokens are verified with the issuer's own keys: `JoseJwtVerifier.localKeys`, `clockTolerance 0`.
- Refusals are logged as `token exchange denied` with `reason invalid_target | invalid_subject_token | invalid_scope`.
- The caller is `OAuthTokenExchanger.exchange` (`src/adapters/local/oauth-token-exchanger.ts`, 2 s timeout), behind `CachingTokenExchanger` (key `jti|audience|scopes`, reused until 30 s before expiry).

---

## 6. Inside the gateway, one request

**What you're looking at:** the classes one `POST /mcp` passes through in `src/apps/gateway`, and every point where a response leaves.

```mermaid
flowchart TD
  in(["POST /mcp from agent-acme"]) --> mh["McpHttpHandler.handle<br/>new trace_id (traceMode start)"]
  mh --> ba["BearerAuthenticator.authenticate"]
  ba --> av["AudienceTokenVerifier aud chainaudit-gateway"] --> jv["JoseJwtVerifier.verify (remote JWKS)"]
  ba -- "no Bearer" --> o401a["401 WWW-Authenticate Bearer resource_metadata=…"]
  jv -- "InvalidTokenError" --> o401b["401 error invalid_token, error_description reason"]
  jv -- "keys unreachable" --> o503["503 temporarily_unavailable"]
  jv -- Principal --> gf["GatewayServerFactory.create<br/>new Server + StreamableHTTPServerTransport"]
  gf --> gs["DefaultGatewayService.listTools or callTool"]
  gs -- "platform target chain" --> px["platformCredential: CachingTokenExchanger → OAuthTokenExchanger"]
  gs -- "tenant target notes" --> tr["tenantTargetsOf: CachingTenantTargetReader → DynamoDbTenantRegistry"]
  tr --> eg["egressFor: CachingTenantTargetReader.getTenantSettings + DefaultEgressValidator + NodeDnsResolver"]
  eg --> cr["tenantCredential: FileCredentialProvider.getSecret"]
  px --> cb["CircuitBreakers.run, key tenant + target"]
  cr --> cb
  cb --> tc["McpTargetClient (MCP SDK client, pinned undici Agent for tenant targets)"]
  tc --> out(["200 JSON-RPC result, passed through"])
  gs -- "unknown name" --> u["isError Unknown tool name"]
  gs -- "scope missing" --> s["isError Tool name requires scope …"]
  px -- "exchange failed" --> x["isError Could not authorize the call to target chain"]
  eg -- "refused" --> e["isError Target notes failed egress validation"]
  cr -- "secret error" --> c["isError Could not authorize the call to target notes"]
  cb -- "open" --> o["isError Target notes is temporarily unavailable (circuit open)"]
  tc -- "timeout, connection, 5xx, 4xx, protocol" --> t["isError Target notes is unavailable"]
```

All `isError` results come back as HTTP **200** with a JSON-RPC `result`: the protocol worked and the tool failed. Every request logs one `mcp request` line with `trace_id`, `tenant_id`, `sub`, `rpc_method`, `tool`, `status` and `duration_ms` (`McpHttpHandler`, on `res close`).

---

## 7. agent-acme lists its tools

**What you're looking at:** `tools/list` merging what agent-acme may use from Caseware's platform target and from acme's own target, both in parallel (`Promise.allSettled`).

```mermaid
sequenceDiagram
  autonumber
  participant A as agent-acme
  participant G as gateway (DefaultGatewayService)
  participant X as CachingTokenExchanger
  participant I as token-issuer
  participant C as registry cache
  participant D as DynamoDB
  participant B as breakers
  participant M as mcp-server
  participant N as acme notes (via :13003)

  A->>G: tools/list (Bearer, scopes chain:read recon:read recon:write tenant:tools)
  par platform target chain
    G->>G: scopesForTarget(chain) = [chain:read]
    G->>X: exchange for aud chainaudit-mcp, scope chain:read
    alt cache miss
      X->>I: token exchange (flow 5)
      I-->>X: exchanged JWT
    end
    X-->>G: token (log target token, exchange hit or miss)
    G->>B: run acme|chain
    B->>M: initialize, initialized, tools/list (Bearer exchanged token)
    M-->>B: get_balance
    G->>G: keep tools in toolScopes, rename chain__get_balance
  and tenant target notes
    G->>C: listActiveTargets(acme)
    opt older than 30 s
      C->>D: Query TENANT#acme, begins_with TARGET#
      D-->>C: notes (active), notes2 and notes3 (pending, dropped)
    end
    G->>G: egress re-validation and secret read (flow 9)
    G->>B: run acme|notes
    B->>N: initialize, initialized, tools/list (X-Api-Key, pinned IPs, 2 s)
    N-->>B: get_client_note
    G->>G: rename notes__get_client_note
  end
  alt one branch failed or its breaker is open
    G->>G: log target list failed, drop that target only
  end
  G-->>A: tools chain__get_balance, notes__get_client_note
```

1. `McpHttpHandler` → `GatewayServerFactory` (`ListToolsRequestSchema`) → `DefaultGatewayService.listTools`.
2. `scopesForTarget` (`src/core/gateway/catalog.ts`). No scope in common means the target isn't called at all.
3. `platformCredential` → `CachingTokenExchanger.exchange`.
4. `OAuthTokenExchanger.exchange` → flow 5.
5. The exchanged token.
6. Log line `target token` with `target_id chain`, `exchange hit|miss`, `scope chain:read`.
7. `CircuitBreakers.run('acme', 'chain', …)`.
8. `McpTargetClient.listTools` (5 s timeout).
9. The MCP server's tools.
10. `isToolVisible` + `namespacedName`. Default deny: a tool missing from `toolScopes` is dropped.
11. `ownTenantTargets`, only if the caller has `tenant:tools`.
12. `CachingTenantTargetReader` → `DynamoDbTenantRegistry.listActiveTargets`.
13. Only `status active` is kept.
14. `listTenantTools` → `egressFor` + `tenantCredential`.
15. `CircuitBreakers.run('acme', 'notes', …)`.
16. `McpTargetClient.listTools` with `connectTo`, `timeoutMs 2000`.
17. The tenant's tools.
18. Every tenant tool is namespaced; there's no per-tool scope map for tenant targets.
19. One failing target never hides the others.
20. A JSON-RPC result with both tools. agent-globex would see only `chain__get_balance` (plus `ledger__…` if globex registered `ledger`).

---

## 8. agent-acme reads Northwind's wallet balance

**What you're looking at:** a complete `chain__get_balance` for Northwind's wallet (illustrated by Anvil account #1). The MCP SDK client opens a session per call, so the gateway sends **four HTTP requests** to the MCP server.

```mermaid
sequenceDiagram
  autonumber
  participant A as agent-acme
  participant G as gateway :3000
  participant I as token-issuer :3002
  participant M as mcp-server :3001
  participant T as Toxiproxy :18545
  participant V as Anvil :8545

  A->>G: POST /mcp tools/call chain__get_balance, address 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  G->>G: new trace_id, verify agent token (aud chainaudit-gateway), principal acme / agent-acme
  G->>G: chain__get_balance → target chain, tool get_balance, needs chain:read: present
  G->>I: token exchange (if not cached): aud chainaudit-mcp, scope chain:read
  I-->>G: JWT sub agent-acme, tenant_id acme, act chainaudit-gateway, exp up to 5 min
  G->>M: POST /mcp initialize (Bearer exchanged token, traceparent 00-trace_id-span-01)
  M->>M: verify aud chainaudit-mcp (JWKS cached), log mcp request rpc_method initialize
  M-->>G: 200 initialize result
  G->>M: POST /mcp notifications/initialized
  M-->>G: 202
  G->>M: GET /mcp (SDK tries to open an SSE stream)
  M-->>G: 405 Method not allowed (stateless)
  G->>M: POST /mcp tools/call get_balance
  M->>M: verify token, check chain:read again (TOOL_SCOPES)
  M->>T: eth_getBalance (viem, 2000 ms, retryCount 0)
  T->>V: forward to anvil:8545
  V-->>T: balance in wei (hex)
  T-->>M: balance
  M->>M: DefaultBalanceService: wei and formatEther, both as strings
  M-->>G: 200 structuredContent address, wei, ether
  G-->>A: 200 same result, unchanged
  Note over G,M: every line on both services carries the same trace_id
```

1. `McpHttpHandler.handle` (gateway).
2. `traceMode start` ignores any incoming `traceparent`. `BearerAuthenticator` → `JoseJwtVerifier`. The logger gains `tenant_id acme`, `sub agent-acme`.
3. `DefaultGatewayService.callTool` → `parseNamespacedName` → `callPlatformTool` → `requiredScope` / `missingScope`.
4. `platformCredential` → `CachingTokenExchanger`. The gateway logs `target token`.
5. `DefaultTokenIssuer.tokenExchange`. The issuer logs `token exchanged`.
6. `McpTargetClient.withClient` → `client.connect`. Headers come from `credentialHeader` (`Authorization Bearer`) plus `traceparent` (`traceparentFor`).
7. MCP server `McpHttpHandler` (`traceMode continue`, same `trace_id`). The log line includes `act chainaudit-gateway`.
8. SDK `initialize`.
9. The notification part of the SDK handshake.
10. The transport answers 202 Accepted for notifications.
11. The SDK client's standalone SSE attempt.
12. `McpHttpHandler.methodNotAllowed`. The SDK handles the 405 quietly. This request isn't logged.
13. `client.callTool`.
14. `ChainToolsServerFactory` callback: `missingScope(principal, 'chain:read')`.
15. `ViemBalanceReader.getBalance`.
16. The `anvil` proxy from `infra/toxiproxy/toxiproxy.json`.
17. Anvil answers.
18. Through Toxiproxy.
19. `DefaultBalanceService.getBalance` + `formatEther` (`src/core/units.ts`). Decimal strings, so JSON never rounds wei.
20. `structuredContent` is validated by the SDK against the output schema.
21. Passed through unchanged.

The note at the end: search the three terminals for the gateway's `trace_id` (`docs/verify.md`, step 7a).

If Anvil is slow (`pnpm chaos add anvil`), step 15 fails after 2000 ms. The MCP server returns `isError: Node provider timed out after 2000 ms`, which reaches agent-acme unchanged. If Anvil is down, the text is `Node provider unavailable`.

---

## 9. agent-acme reads acme's note about Northwind

**What you're looking at:** a call to acme's **own** server, `notes__get_client_note("Northwind Ltd")`. Caseware's gateway treats acme's server as a third party.

```mermaid
sequenceDiagram
  autonumber
  participant A as agent-acme
  participant G as gateway
  participant C as registry cache 30 s
  participant D as DynamoDB
  participant N as DNS (dns.lookup)
  participant S as .secrets
  participant B as breaker acme|notes
  participant P as Toxiproxy acme-notes :13003
  participant T as acme notes :3003

  A->>G: tools/call notes__get_client_note, client_name Northwind Ltd
  G->>G: notes is not a platform target id
  G->>C: listActiveTargets(acme), tenant from the token
  opt cache older than 30 s
    C->>D: Query PK TENANT#acme, begins_with(SK, TARGET#)
    D-->>C: TARGET#notes, base_url http://localhost:13003/mcp, active
  end
  C-->>G: notes found among acme's targets
  G->>G: tenant:tools present
  G->>C: getTenantSettings(acme)
  C-->>G: allowed_domains [localhost]
  G->>N: resolve localhost, fresh
  N-->>G: ::1, 127.0.0.1
  G->>G: http allowed (local mode), hostname not an IP, localhost allowed, both loopback allowed
  G->>S: getSecret(principal acme, /tenants/acme/targets/notes)
  S-->>G: acme-sample-key (ref tenant acme = principal tenant acme)
  G->>B: run
  B->>P: initialize, initialized, tools/call get_client_note (X-Api-Key, traceparent, 2 s, socket only to ::1 or 127.0.0.1, Host localhost:13003)
  P->>T: forward to host.docker.internal:3003
  T->>T: ApiKeyGuard: SHA-256 of key compared in constant time
  T-->>P: structuredContent client_name Northwind Ltd, note Holds treasury in a 2-of-3 multisig…
  P-->>B: result
  B->>B: success recorded in the last-10 window
  B-->>G: result
  G-->>A: 200 result, unchanged
```

1. `McpHttpHandler` → `DefaultGatewayService.callTool`.
2. `this.platformTargets.find(...)` misses.
3. `tenantTargetsOf` → `CachingTenantTargetReader.listActiveTargets` (`src/core/registry/caching-target-reader.ts`).
4. `DynamoDbTenantRegistry.listActiveTargets` (`QueryCommand`, paginated, never Scan).
5. `toTarget` maps the item.
6. If `notes` weren't in **acme's** list, the result would be `isError Unknown tool notes__get_client_note`, as agent-globex gets.
7. `missingScope(principal, TENANT_TOOLS_SCOPE)`. Missing: `Tool notes__get_client_note requires scope tenant:tools`.
8. `egressFor` → `getTenantSettings`.
9. Cached 30 s, like the targets.
10. `DefaultEgressValidator.validate` → `NodeDnsResolver.resolve` (2 s race). DNS is never cached by us.
11. `dns.lookup` with `all: true`.
12. `classifyIp` per address. The gateway logs `egress validated` with `target_id notes`, `connect_to ["::1","127.0.0.1"]`.
13. `tenantCredential` → `FileCredentialProvider.getSecret` → `pathFor` (tenant check).
14. The file `.secrets/tenants/acme/targets/notes`.
15. `CircuitBreakers.run('acme', 'notes', …)`.
16. `McpTargetClient.callTool`: `credentialHeader` (`X-Api-Key`), and `pinnedAgent` (an undici `Agent` whose `connect.lookup` returns only the validated IPs).
17. Toxiproxy proxy `acme-notes`.
18. `NotesHttpHandler.handle` → `ApiKeyGuard.allows`.
19. `ClientNotesServerFactory` → `get_client_note`.
20. Back through the proxy.
21. `CircuitBreaker.record`.
22. Result.
23. Passed through.

---

## 10. acme-admin registers `notes`

**What you're looking at:** acme's administrator registering acme's own MCP server, and every possible outcome.

Request body:

```
{"target_id":"notes","name":"Client notes","base_url":"http://localhost:13003/mcp","auth_type":"api_key","api_key":"acme-sample-key"}
```

```mermaid
sequenceDiagram
  autonumber
  participant AD as acme-admin
  participant I as token-issuer
  participant H as RegisterTargetHandler
  participant R as DefaultTargetRegistrar
  participant D as DynamoDB
  participant E as DefaultEgressValidator
  participant S as .secrets
  participant T as acme notes via :13003

  AD->>I: client_credentials acme-admin:acme-admin-local-secret
  I-->>AD: JWT tenant_id acme, scope registry:admin, aud chainaudit-gateway
  AD->>H: POST /admin/targets (Bearer)
  alt no or invalid token
    H-->>AD: 401
  else token without registry:admin (e.g. agent-acme)
    H-->>AD: 403 insufficient_scope, WWW-Authenticate scope=registry:admin
  else body invalid or contains tenant_id
    H-->>AD: 400 invalid_request body: Unrecognized key tenant_id
  end
  H->>R: register(principal acme, registration)
  R->>R: target_id is a slug and not reserved (chain is)
  R->>D: GetItem TENANT#acme CONFIG
  D-->>R: allowed_domains [localhost], max_targets 3
  R->>E: validate(base_url, [localhost])
  alt refused (IP literal, other domain, credentials in URL, blocked address)
    R-->>AD: 400 with the reason, e.g. base_url must use a hostname, not an IP address
  end
  R->>D: TransactWriteItems: Update CONFIG if target_count < max_targets, Put TARGET#notes v1 pending if attribute_not_exists(SK)
  alt cancelled, TARGET condition failed
    R->>D: GetItem TARGET#notes
    R-->>AD: 200 existing (same name, base_url, auth_type, re-probed if pending) or 409 conflict
  else cancelled, CONFIG condition failed
    R-->>AD: 429 quota_exceeded (404 unknown_tenant if CONFIG missing)
  end
  R->>S: putSecret /tenants/acme/targets/notes (dir 700, file 600)
  R->>T: probe initialize + tools/list, X-Api-Key, pinned to validated IPs, 5 s
  alt probe fails
    T-->>R: 401 wrong key, or connection refused, or timeout
    R->>D: Update status pending, status_reason health probe failed …, version 2 if version = 1
  else probe passes
    T-->>R: get_client_note
    R->>D: Update status active, version 2 if version = 1
  end
  R-->>AD: 201 target_id, name, base_url, auth_type, secret_ref, status, version 2, created_at (never the key)
```

1. `DefaultTokenIssuer.clientCredentials`.
2. The `registry:admin` scope is only on the `*-admin` clients.
3. The gateway route `POST /admin/targets` → `RegisterTargetHandler.handle`.
4. `BearerAuthenticator` failed; logged as `admin request rejected`.
5. `missingScope(caller, 'registry:admin')`; logged as `admin request denied`.
6. `bodySchema.strict()` (zod) → `badRequest`.
7. `DefaultTargetRegistrar.register(principal, …)`. The tenant comes only from the token.
8. `ID_PATTERN` + `reservedTargetIds` (from `STATIC_TARGETS`) → `invalid`.
9. `registry.getTenantSettings`.
10. The CONFIG item (`unknown_tenant` → 404 if missing).
11. `DefaultEgressValidator.validate` (flow 13).
12. Logged as `target registration refused` with the reason. Nothing is stored or called.
13. `DynamoDbTenantRegistry.createTarget` (`TransactWriteCommand` with both `ConditionExpression`s).
14. `CancellationReasons[1]` is `ConditionalCheckFailed` → `duplicate` → `getTarget`.
15. `sameDefinition`. Same → 200 `existing`; if the target is still pending, the new key is stored and the probe runs again. Different → 409 `conflict`.
16. `CancellationReasons[0]` → `quota_exceeded` (429), or `unknown_tenant` (404) when `tenantExists` is false.
17. `FileCredentialProvider.putSecret`. The registry gets only `secret_ref`. Logged as `target registered`.
18. `DefaultTargetRegistrar.probe` → `McpTargetClient.listTools` with `connectTo`. **No breaker, default 5 s timeout.**
19. `toTargetCallError` reasons: `rejected the credentials (HTTP 401)`, `connection refused`, `timed out`. Logged as `target probe failed`.
20. `updateTargetStatus('pending', 'health probe failed: …')` with `ConditionExpression version = :expected`. A version conflict re-reads the item (`target status changed concurrently`).
21. Logged as `target probe passed` with the tool count.
22. `updateTargetStatus('active')`.
23. `view()` + `toHttp`: 201 for created, 200 for existing.

---

## 11. The life of a registry item

**What you're looking at:** the `status` and `version` of one `TARGET#` item over time.

```mermaid
stateDiagram-v2
  [*] --> Pending_v1: TransactWriteItems Put (status pending, version 1)
  Pending_v1 --> Active_v2: probe passes, Update version = 1
  Pending_v1 --> PendingWithReason_v2: probe fails, status_reason set
  PendingWithReason_v2 --> PendingWithReason_vN: re-registered with the same definition, probe fails again
  PendingWithReason_v2 --> Active_vN: re-registered with the same definition, new key stored, probe passes
  PendingWithReason_vN --> Active_vN: re-registered, probe passes
  Active_v2 --> Active_v2: re-registered with the same definition, 200 existing, nothing written
  Active_v2 --> Active_v2: different definition, 409 conflict, nothing written
  Active_vN --> Active_vN: same as Active_v2
  Active_v2 --> Disabled: design only, no API sets it
  Disabled --> [*]
```

- Routing only uses `active` items (`listActiveTargets`). Pending ones never reach agents.
- Every status update bumps `version` by 1, under a condition on the version just read (optimistic concurrency).
- Items are only removed by restarting DynamoDB Local. There's no delete API.

---

## 12. Isolation scenarios

**What you're looking at:** each way one party might try to reach another party's things, and the check that stops it.

```mermaid
flowchart TD
  s1(["agent-globex calls notes__get_client_note"]) --> c1{"notes in globex's own active targets?<br/>listActiveTargets(globex) queries TENANT#globex only"}
  c1 -- no --> r1["isError Unknown tool notes__get_client_note<br/>(the registry was never asked about acme)"]

  s2(["agent-acme with scope chain:read only calls notes__get_client_note"]) --> c2{"tenant:tools in the token?"}
  c2 -- no --> r2["isError Tool notes__get_client_note requires scope tenant:tools"]

  s3(["agent-acme calls POST /admin/targets"]) --> c3{"registry:admin in the token?"}
  c3 -- no --> r3["403 insufficient_scope"]

  s4(["acme-admin sends tenant_id globex in the body"]) --> c4{"body schema strict?"}
  c4 -- "unknown key" --> r4["400 invalid_request, nothing registered"]

  s5(["code asks for /tenants/acme/targets/notes with globex's principal"]) --> c5{"ref tenant = principal tenant?"}
  c5 -- no --> r5["CredentialAccessDeniedError<br/>(in AWS: IAM ABAC denial, design only)"]

  s6(["agent-acme's own token sent straight to mcp-server :3001"]) --> c6{"aud = chainaudit-mcp?"}
  c6 -- "no, aud chainaudit-gateway" --> r6["401 error invalid_token, unexpected audience"]

  s7(["anyone re-exchanges an exchanged token"]) --> c7{"subject aud = chainaudit-gateway and no act?"}
  c7 -- no --> r7["400 invalid_request subject token is invalid"]

  s8(["acme's breaker for notes is open"]) --> c8{"breaker key"}
  c8 -- "acme + notes" --> r8["acme gets circuit open"]
  c8 -- "globex + ledger, acme + chain" --> r9["unaffected"]
```

Tests that prove these in `src/core`:

- `gateway-service.test.ts`: s1, s2, s8;
- `target-registrar.test.ts`;
- `token-issuer.test.ts`.

`pnpm verify` covers s1 to s4, s6 and s7 end to end.

---

## 13. A DNS rebinding attack

**What you're looking at:** an attacker who controls the DNS for a hostname on a tenant's allowed list (say `api.evil-tenant.example`, with the attacker's DNS server). It answers a public IP when checked and an internal IP when used. The left side is what the code does. The dashed part is what a validator **without** pinning would let happen.

```mermaid
sequenceDiagram
  autonumber
  participant AD as malicious tenant admin
  participant G as gateway
  participant DNS as attacker's DNS
  participant PUB as public IP 93.184.216.34
  participant INT as internal IP 10.0.0.5 (design only target)

  AD->>G: register https://api.evil-tenant.example/mcp
  G->>DNS: resolve (registration)
  DNS-->>G: 93.184.216.34
  G->>G: every address public, ok
  G->>PUB: probe, socket pinned to 93.184.216.34
  PUB-->>G: tools, status active
  Note over DNS: attacker switches the record
  G->>DNS: resolve again before the call (egressFor)
  DNS-->>G: 10.0.0.5
  G->>G: classifyIp 10.0.0.5 = private, refused
  G-->>AD: isError Target … failed egress validation, log egress validation failed with the reason
  Note over G,INT: no connection is made to 10.0.0.5
  rect rgba(200,200,200,0.15)
    Note over G,INT: without pinning (what the code prevents)
    G-->>DNS: validator resolves: 93.184.216.34, passes
    G-->>DNS: HTTP client resolves again on its own: 10.0.0.5
    G-->>INT: request reaches the internal service
  end
```

1. `RegisterTargetHandler` → `DefaultTargetRegistrar.register`.
2. `DefaultEgressValidator.validate` → `NodeDnsResolver.resolve`.
3. The attacker's first answer.
4. `classifyIp` → `public`. The name is on the tenant's `allowed_domains`.
5. `probe` with `connectTo [93.184.216.34]` (`pinnedAgent`).
6. Status `active`. Then (the note) the attacker switches the record. DNS is never cached by the gateway.
7. `DefaultGatewayService.egressFor` runs before **every** tenant call.
8. The second answer.
9. `classifyIp` → `private`. A name with even one blocked address fails as a whole.
10. `callTool` returns `Target <id> failed egress validation`. For `tools/list` the target drops out. Logged as `egress validation failed`.
11. In the grey lane, a validator without pinning resolves and passes.
12. The HTTP client then resolves the name again on its own and gets the internal IP.
13. The request reaches the internal service. This lane is **not** possible here: for tenant targets, `McpTargetClient` connects through a lookup that can only return the addresses validated for that call.

The same refusal covers names that resolve to `169.254.169.254` (`link_local`), `::ffff:10.0.0.5` (`ipv4_mapped`) or `127.0.0.1` (`loopback`, accepted only in local mode). Test: `gateway-service.test.ts`, "stops a DNS rebinding".

---

## 14. The breaker during the chaos demo

**What you're looking at:** a timeline of `pnpm chaos` breaking acme's `notes` while globex and acme's platform tool keep working (`docs/verify.md`, step 7k).

```mermaid
sequenceDiagram
  autonumber
  participant Y as you
  participant X as Toxiproxy API :8474
  participant G as gateway
  participant B as breaker acme|notes
  participant P as acme-notes :13003
  participant L as globex ledger :3004
  participant M as mcp-server (acme|chain)

  Y->>X: pnpm chaos add acme-notes (latency 3000 ms, downstream)
  loop agent-acme calls notes__get_client_note
    G->>B: run
    B->>P: call, 2 s timeout
    P--xB: no answer within 2000 ms
    B->>B: record failure (TargetCallError timeout)
    B-->>G: error
    G-->>Y: isError Target notes is unavailable, about 2 s
  end
  B->>B: window has 10 results, at least half failures
  B-->>G: transition closed to open
  G-->>Y: log warn circuit breaker transition tenant_id acme, target_id notes, from closed, to open
  Y->>G: agent-acme calls notes__get_client_note again
  G->>B: run
  B-->>G: CircuitOpenError, target not called
  G-->>Y: isError Target notes is temporarily unavailable (circuit open), a few ms
  Y->>G: agent-globex calls ledger__get_client_note
  G->>L: globex|ledger breaker closed, direct call
  L-->>G: note
  G-->>Y: answered
  Y->>G: agent-acme calls chain__get_balance
  G->>M: acme|chain breaker closed
  M-->>G: balance
  G-->>Y: answered
  Y->>X: pnpm chaos remove acme-notes
  Note over B: 15 s pass
  Y->>G: agent-acme calls notes__get_client_note
  G->>B: run
  B-->>G: transition open to half_open, this call is the probe
  alt probe succeeds
    B->>P: call
    P-->>B: note
    B-->>G: transition half_open to closed, window cleared
    G-->>Y: note
  else toxic still there, probe fails
    P--xB: timeout
    B-->>G: transition half_open to open, 15 s more
    G-->>Y: isError Target notes is unavailable
  end
```

1. `scripts/chaos.ts add` → Toxiproxy `POST /proxies/acme-notes/toxics`, toxic `chaos_latency`.
2. `CircuitBreakers.run('acme', 'notes', …)` (one breaker per `tenant|target`).
3. `McpTargetClient`, with `timeoutMs` from `TENANT_TARGET_TIMEOUT_MS=2000`.
4. The latency toxic delays the response beyond 2 s.
5. `isTargetFailure` is true for `timeout`, `connection` and `http_5xx`. 4xx and protocol errors count as successes.
6. Thrown on to the gateway service.
7. `callTool` catch → `Target notes is unavailable`.
8. `CircuitBreaker.record`. It happens after 5 to 10 failures, depending on how many earlier successes are still in the window.
9. `move('open')`, `openedAt = now`.
10. `logger.warn('circuit breaker transition', …)` with the request's `trace_id`, plus `failures` and `calls`.
11. The next call.
12. `CircuitBreaker.run`.
13. Open and less than 15 s → `CircuitOpenError`, and `fn` isn't called.
14. `circuitOpen(targetId)`.
15. agent-globex.
16. A different key (`globex|ledger`), and no proxy.
17. Answer.
18. Answered.
19. acme's platform tool.
20. A different key (`acme|chain`).
21. Answer.
22. Answered.
23. `scripts/chaos.ts remove` → `DELETE /proxies/acme-notes/toxics/chaos_latency`. Then (the note) 15 s pass. There's no timer; the check happens on the next call.
24. The next call.
25. `CircuitBreaker.run`.
26. `move('half_open')`. This call is the probe, and concurrent calls get `CircuitOpenError`.
27. The probe.
28. Answer.
29. `record(…, probe)` → `move('closed')`, `window = []`.
30. The note.
31. Probe failure (toxic still in place).
32. `move('open')`, a new `openedAt`.
33. The error result.

---

## 15. Error map

**What you're looking at:** every failure, grouped by where it's produced, and exactly what the caller receives.

```mermaid
flowchart LR
  subgraph issuer["token-issuer POST /oauth2/token"]
    i1["401 invalid_client: Client authentication failed"]
    i2["400 invalid_request: grant_type, subject_token, audience, scope required, token types, subject token is invalid"]
    i3["400 unsupported_grant_type, 400 unauthorized_client, 400 invalid_scope, 400 invalid_target"]
    i4["500 server_error: Unexpected error while issuing the token"]
  end
  subgraph auth["gateway and mcp-server, before MCP"]
    a1["401 Bearer: missing bearer token, or error invalid_token with reason:<br/>token expired, invalid signature, unexpected audience,<br/>unexpected issuer, unexpected token type, algorithm not allowed,<br/>unknown signing key, malformed token, malformed claims"]
    a2["503 temporarily_unavailable: issuer keys unreachable"]
    a3["405 JSON-RPC -32000 Method not allowed: GET or DELETE /mcp"]
    a4["500 JSON-RPC -32603 Internal server error: transport failure"]
  end
  subgraph tools["gateway tool results: HTTP 200, isError true"]
    t1["Unknown tool name"]
    t2["Tool name requires scope chain:read or tenant:tools"]
    t3["Could not authorize the call to target chain (exchange) or notes (secret)"]
    t4["Target notes failed egress validation"]
    t5["Target id is temporarily unavailable (circuit open)"]
    t6["Target id is unavailable"]
  end
  subgraph mcpt["mcp-server tool results: HTTP 200, isError true, passed through"]
    m1["Node provider timed out after 2000 ms"]
    m2["Node provider unavailable"]
    m3["Tool get_balance requires scope chain:read"]
    m4["address must be 0x followed by 40 hex characters (input validation)"]
    m5["Internal error while reading the balance"]
  end
  subgraph admin["gateway POST /admin/targets"]
    d1["400 invalid_request: schema errors, tenant_id not accepted, egress reasons, reserved or bad target_id"]
    d2["401 / 403 insufficient_scope registry:admin"]
    d3["404 unknown_tenant, 409 conflict, 429 quota_exceeded, 500 server_error"]
    d4["201 or 200 with status pending and status_reason:<br/>health probe failed: rejected the credentials (HTTP 401), connection refused, timed out"]
  end
  subgraph tenant["tenant sample server"]
    s1["401 JSON-RPC -32001 Invalid API key"]
    s2["isError: No note for client name"]
  end
```

Sources:

- **token-issuer:** `fail(...)` / `oauthError(...)` in `token-issuer.ts` and `token-endpoint-handler.ts`.
- **gateway and mcp-server auth:** `BearerAuthenticator` and `toDomainError` in `jose-jwt-verifier.ts`.
- **gateway tool results:** `toolError(...)` / `circuitOpen(...)` in `gateway-service.ts`.
- **mcp-server tool results:** `toToolError` and `TOOL_SCOPES` in `chain-tools-server-factory.ts`.
- **admin API:** `toHttp` in `register-target-handler.ts`.
- **tenant sample server:** `NotesHttpHandler` and `ClientNotesServerFactory`.

**Rule of thumb:** HTTP errors mean "you can't be served at all" (authentication, protocol, admin input). `isError` means "the tool ran into a problem the model can reason about". Raw errors never reach agents; causes are logged with `trace_id`.

---

## 16. Northwind's reconciliation, end to end (design only)

**What you're looking at:** none of this is built. It's the RFC's design ("Sync and async flows", "On premise relay", "Data layer"), told with the cast. agent-acme asks whether Northwind's on-chain transactions match Northwind's ledger. The ledger lives on a desktop app at the firm or at Northwind.

```mermaid
sequenceDiagram
  autonumber
  participant A as agent-acme
  participant G as gateway / AgentCore (design only)
  participant S as start_reconciliation (design only)
  participant DB as PostgreSQL / Aurora (design only)
  participant O as outbox publisher (design only)
  participant Q as SQS (design only)
  participant W as reconciliation worker (design only)
  participant F as fetch_client_ledger (design only)
  participant R as WebSocket relay (design only)
  participant DT as desktop client at acme or Northwind (design only)

  A->>G: tools/call start_reconciliation, engagement Northwind 2026, idempotency_key k1 (scope recon:write)
  G->>S: exchanged token, tenant acme
  S->>DB: one transaction: INSERT job ON CONFLICT DO NOTHING + INSERT outbox reconciliation.requested
  S-->>A: job_id (the same id if k1 is retried)
  O->>DB: SELECT unpublished outbox rows
  O->>Q: publish reconciliation.requested
  O->>DB: set published_at
  Q->>W: deliver (at least once)
  W->>DB: claim job FOR UPDATE SKIP LOCKED, set running
  W->>F: need Northwind's ledger
  F->>DB: pending record correlation_id, deadline, TTL
  F->>R: postToConnection to acme's desktop session
  R->>DT: request with correlation_id
  alt desktop online
    DT-->>R: ledger rows
    R->>F: result into the pending record
    F-->>W: ledger entries stored with ON CONFLICT
  else desktop offline
    W->>DB: job status blocked, resumes on reconnect
  end
  W->>DB: FULL OUTER JOIN final chain_transactions with ledger_entries for the engagement
  W->>DB: store results: matched, amount_mismatch, missing_in_ledger, missing_on_chain
  A->>G: tools/call get_reconciliation_status job_id (scope recon:read)
  G-->>A: status and findings
```

1. The RFC tool table: `start_reconciliation`, scope `recon:write`, async, requires an idempotency key.
2. The identity chain would match flows 5 and 8 (in AWS: Cognito and AgentCore Identity, verify in AWS docs).
3. RFC "Data layer". It's exercised by hand in `docs/sql-lab.sql`, exercises 2 and 3.
4. Idempotent: a retried key returns the original job.
5. RFC "Why an outbox": it avoids the dual-write gap.
6. SQS (Simple Queue Service). A DLQ after 3 attempts, in the ingestion design.
7. `published_at`.
8. At-least-once delivery, so every consumer is idempotent.
9. SQL lab exercise 4 (`SKIP LOCKED`).
10. The relay tool from the RFC table: `fetch_client_ledger`, scope `ledger:read`.
11. RFC "On premise relay": the pending record in DynamoDB.
12. API Gateway WebSocket `postToConnection` (verify in AWS docs).
13. The desktop dials out, so nothing on premise accepts inbound traffic.
14. Its reply arrives via the `$default` route, possibly at another Lambda.
15. The waiting Lambda reads the pending record.
16. `ledger_entries` has `UNIQUE (engagement_id, entry_ref)`.
17. RFC degradation: `blocked` instead of failing.
18. SQL lab exercise 5c, with the filters inside the subqueries (5d shows the WHERE bug).
19. The four outcomes.
20. `get_reconciliation_status`, scope `recon:read`, polled.
21. Status and findings.

The same flow on AWS (design only): AgentCore Gateway with Cognito inbound → Lambda tools → Aurora Serverless v2 (Data API) → an outbox publisher Lambda → SQS with a DLQ → a worker Lambda → API Gateway WebSocket for the relay, with a DynamoDB pending table and connections table.
