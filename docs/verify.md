# Verify everything from scratch

This runbook takes a clean machine state to a fully verified stack (tasks 1 to 4b). Steps 1 to 5 set things up, step 6 runs the automated checks (`pnpm verify`), and step 7 covers the few checks that need logs or restarts.

Prerequisites: Docker Desktop running, `nvm`, and Node 24 (`.nvmrc`).

## 1. Reset to a clean state (optional, for a true from-scratch run)

```bash
docker compose -f infra/docker-compose.yml down -v   # stops containers and deletes the Postgres volume
rm -rf .keys .secrets node_modules                   # issuer signing key, tenant secrets and deps
```

Expected: `Container chainaudit-… Removed` lines and `Volume chainaudit_pgdata Removed`.

## 2. Toolchain and dependencies

```bash
nvm install && nvm use      # Now using node v24.x
corepack enable
pnpm --version              # 10.34.6
pnpm install                # installs the pinned versions from pnpm-lock.yaml
pnpm why jose               # a single version: jose 6.2.12
pnpm typecheck              # no output, exit 0
pnpm test                   # unit tests of the core services with fakes: 3 files, all passed (no services needed)
```

## 3. Infrastructure

```bash
pnpm infra:up
pnpm infra:ps               # 5 services "running"; anvil and postgres show "(healthy)"
```

If Anvil isn't healthy, run `docker compose -f infra/docker-compose.yml logs anvil`.

Then create the tenant registry. DynamoDB Local is in memory too, so **run this after every `infra:up`**:

```bash
pnpm setup:dynamodb
# table chainaudit-registry created   (or: already exists)
# CONFIG for acme: max_targets 3, allowed_domains localhost
# CONFIG for globex: max_targets 1, allowed_domains localhost
```

## 4. Seed Anvil

Anvil keeps its state in memory, so **run this again after every restart of the Anvil container**.

```bash
pnpm seed:anvil
```

Expected: five lines like `#0 -> #1  1 ETH  block N  0x…`, then the balances. Account #1 (`0x7099…79C8`) ends up at about 9999.5 ETH.

## 5. Start the four services (one terminal each, in this order)

```bash
pnpm issuer:dev          # {"msg":"token issuer listening","port":3002,…,"kid":"…"}  (creates .keys/ on first run)
pnpm mcp:dev             # {"msg":"mcp server listening","port":3001,…,"audience":"chainaudit-mcp"}
pnpm tenant-sample:dev   # {"msg":"tenant sample server listening","port":3003}
pnpm gateway:dev         # {"level":"warn","msg":"egress: private networks allowed for tenant targets (APP_ENV=local)",…}
                         # {"msg":"gateway listening","port":3000,…,"targets":["chain"],"registry":"chainaudit-registry","app_env":"local"}
```

`gateway:dev` sets `APP_ENV=local EGRESS_ALLOW_PRIVATE_NETWORKS=true`, so tenant targets on `localhost` are allowed; the warning says so.

The issuer must be running before the first request to the gateway or the MCP server, because both fetch its JWKS.

## 6. Automated checks

```bash
pnpm verify                 # everything
pnpm verify --no-faults     # skips the Toxiproxy latency and outage checks
```

Expected: every line is `PASS`, ending with `N passed, 0 failed`. The script exits 1 if any check fails, and stops early if a service from steps 3 to 5 isn't listening. It never starts or stops services. The only state it changes is a temporary Toxiproxy toxic, which it always removes, even when a check fails.

What it covers:

| Section | Checks |
| --- | --- |
| Preflight | All ports open, Node matches `.nvmrc`, `pnpm typecheck` |
| Task 1: infra | DynamoDB `ListTables`, Postgres 17.11, Anvil direct and through Toxiproxy (chain id `0x7a69`), Toxiproxy proxy config, Jaeger UI, OTLP on 4318 |
| Task 3: issuer | JWKS has a public key only; token fields, header (`ES256`, `at+jwt`, `kid`) and claims; default scope; `invalid_scope`; `invalid_client` returns the same answer for a wrong secret and an unknown client; `unsupported_grant_type`; `invalid_request` |
| Task 4b: exchange | Exchanged token (`aud`, `sub`, `tenant_id`, `act`, 5 min); `invalid_scope`; `invalid_target`; re-exchange refused; agents and the gateway limited to their own grant types |
| Tasks 2 + 4b: MCP server | 401 without a token; the agent's token is refused (`unexpected audience`, so no passthrough); `tools/list`; balance as decimal strings; Anvil seeded; bad address gives `isError`; the server re-checks scope itself; `GET /mcp` gives 405 |
| Task 4a: gateway | Protected resource metadata at both URLs; 401 with `resource_metadata`; tampered token; HS256 token rejected; a token for the MCP server is refused; namespaced and scope-filtered `tools/list`; a call routed through the gateway; missing scope; unknown tool; 405 |
| Task 5a: registry | Table and acme CONFIG; register `notes` (active), idempotent repeat, 409 conflict, 403 without `registry:admin`, 400 for `tenant_id` in the body, pending with a reason for a wrong key and a dead URL, 429 at the quota; acme vs globex catalogs and calls; no `tenant:tools` refused; DynamoDB holds no key; secret file mode 600; sample server needs its key |
| Task 5b: egress | 400 for an IP literal, decimal, hex, metadata IP, IPv6 literal, a domain outside the allowlist and userinfo; refused URLs are never stored |
| Task 2: failures | 3 s Toxiproxy latency gives "Node provider timed out after 2000 ms" in about 2 s; proxy disabled gives "Node provider unavailable"; recovery afterwards |

## 6b. The same checks by hand

These are the commands `pnpm verify` runs, to copy and paste one at a time from the repo root. They work in zsh and bash. Lines are kept short, because a long line that wraps while being pasted can split a header and break the request (Jetty rejects that as "Line Folding not supported").

**Helpers (paste once per terminal):**

```bash
ISS=localhost:3002/oauth2/token
J='Content-Type: application/json'
ACC='Accept: application/json, text/event-stream'
ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
at()  { node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token'; }
jwt() { node -e 'for (const p of process.argv[1].split(".").slice(0,2))
  console.log(JSON.parse(Buffer.from(p,"base64url")))' "$1"; }
# tok <client:secret> [scope]   (an empty scope means "all allowed scopes")
tok() { curl -s -u "$1" -d grant_type=client_credentials \
  --data-urlencode "scope=$2" $ISS; }
# xchg <subject token> <audience> <scope>   (as the gateway client)
xchg() { curl -s -u chainaudit-gateway:gateway-local-secret \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  -d subject_token_type=urn:ietf:params:oauth:token-type:access_token \
  --data-urlencode "subject_token=$1" -d "audience=$2" \
  --data-urlencode "scope=$3" $ISS; }
# mcp <url> <token> <json body>   (prints status line, headers and body)
mcp() { curl -s -i "$1" -H "Authorization: Bearer $2" \
  -H "$J" -H "$ACC" -d "$3"; }
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
call() { printf '{"jsonrpc":"2.0","id":2,"method":"tools/call",%s}' \
  "\"params\":{\"name\":\"$1\",\"arguments\":{\"address\":\"${2:-$ADDR}\"}}"; }
```

### Task 1: infrastructure

```bash
# 1.1 DynamoDB Local -> {"TableNames":[]}  (or the tables created so far)
AUTH='AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request'
curl -s -X POST localhost:8000 \
  -H 'Content-Type: application/x-amz-json-1.0' \
  -H 'X-Amz-Target: DynamoDB_20120810.ListTables' \
  -H "Authorization: $AUTH, SignedHeaders=host, Signature=x" -d '{}'

# 1.2 PostgreSQL -> PostgreSQL 17.11 … aarch64 …
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U chainaudit -tAc 'select version()'

# 1.3 Anvil direct and 1.4 through Toxiproxy -> both {"jsonrpc":"2.0","id":1,"result":"0x7a69"}
CHAIN='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
curl -s -X POST localhost:8545 -H "$J" -d "$CHAIN"; echo
curl -s -X POST localhost:18545 -H "$J" -d "$CHAIN"; echo

# 1.5 Toxiproxy -> {"anvil":{…,"upstream":"anvil:8545","enabled":true,"toxics":[]}}
curl -s localhost:8474/proxies; echo

# 1.6 Jaeger UI -> 200 ; 1.7 OTLP over HTTP -> {"partialSuccess":{}} 200
curl -s -o /dev/null -w '%{http_code}\n' localhost:16686
curl -s -w ' %{http_code}\n' -X POST localhost:4318/v1/traces \
  -H "$J" -d '{"resourceSpans":[]}'
```

### Task 3: token issuer

```bash
# 3.1 JWKS -> one key: "kty":"EC","crv":"P-256","alg":"ES256","use":"sig", a kid, and no "d"
curl -s localhost:3002/.well-known/jwks.json; echo

# 3.2 Token -> {"access_token":"eyJ…","token_type":"Bearer","expires_in":900,
#                "scope":"chain:read recon:read"}
tok agent-acme:acme-local-secret 'chain:read recon:read'; echo

# 3.3 Decode it
#     header:  { alg: 'ES256', kid: '…', typ: 'at+jwt' }
#     payload: { tenant_id: 'acme', scope: 'chain:read recon:read',
#                iss: 'http://localhost:3002', aud: 'chainaudit-gateway',
#                sub: 'agent-acme', iat, exp (iat + 900), jti }
A=$(tok agent-acme:acme-local-secret 'chain:read recon:read' | at)
jwt "$A"

# 3.4 Response headers -> Cache-Control: no-store and Pragma: no-cache
curl -s -i -u agent-acme:acme-local-secret -d grant_type=client_credentials $ISS \
  | grep -Ei '^(cache-control|pragma)'

# 3.5 No scope -> "scope":"chain:read recon:read recon:write"
tok agent-acme:acme-local-secret; echo

# 3.6 Scope not allowed -> {"error":"invalid_scope",…} 400
curl -s -w ' %{http_code}\n' -u agent-globex:globex-local-secret \
  -d grant_type=client_credentials -d scope=recon:write $ISS

# 3.7 Wrong secret and 3.8 unknown client
#     both: HTTP/1.1 401, WWW-Authenticate: Basic realm="chainaudit-token-issuer",
#     and the same "Client authentication failed"
curl -s -i -u agent-acme:wrong -d grant_type=client_credentials $ISS \
  | grep -Ei '^HTTP|www-auth|error'
curl -s -i -u nobody:x -d grant_type=client_credentials $ISS \
  | grep -Ei '^HTTP|www-auth|error'

# 3.9 Wrong grant -> {"error":"unsupported_grant_type",…} 400
curl -s -w ' %{http_code}\n' -u agent-acme:acme-local-secret \
  -d grant_type=password $ISS

# 3.10 Missing grant_type -> {"error":"invalid_request",…} 400
curl -s -w ' %{http_code}\n' -u agent-acme:acme-local-secret \
  -d scope=chain:read $ISS
```

### Task 4b: token exchange

```bash
# 4b.1 Exchange -> {"access_token":"eyJ…",
#        "issued_token_type":"urn:ietf:params:oauth:token-type:access_token",
#        "token_type":"Bearer","expires_in":300,"scope":"chain:read"}
xchg "$A" chainaudit-mcp chain:read; echo

# 4b.2 Decode -> payload { tenant_id: 'acme', scope: 'chain:read',
#                  act: { sub: 'chainaudit-gateway' }, aud: 'chainaudit-mcp',
#                  sub: 'agent-acme', exp (iat + 300) }
X=$(xchg "$A" chainaudit-mcp chain:read | at)
jwt "$X"

# 4b.3 Scope the agent token lacks -> {"error":"invalid_scope",…}
xchg "$A" chainaudit-mcp recon:write; echo

# 4b.4 Audience not allowed -> {"error":"invalid_target",…}
xchg "$A" some-other-service chain:read; echo

# 4b.5 Re-exchange an exchanged token
#      -> {"error":"invalid_request","error_description":"subject token is invalid"}
xchg "$X" chainaudit-mcp chain:read; echo

# 4b.6 An agent tries to exchange -> {"error":"unauthorized_client",…}
curl -s -u agent-acme:acme-local-secret \
  -d grant_type=urn:ietf:params:oauth:grant-type:token-exchange $ISS; echo

# 4b.7 The gateway asks for its own token -> {"error":"unauthorized_client",…}
curl -s -u chainaudit-gateway:gateway-local-secret \
  -d grant_type=client_credentials $ISS; echo
```

### Tasks 2 and 4b: MCP server, called directly

```bash
# 2.1 No token -> HTTP/1.1 401, WWW-Authenticate: Bearer
curl -s -i localhost:3001/mcp -H "$J" -H "$ACC" -d "$(call get_balance)" \
  | grep -Ei '^HTTP|www-auth'

# 2.2 Agent token (aud gateway) -> 401, error_description="unexpected audience"
mcp localhost:3001/mcp "$A" "$(call get_balance)" | grep -Ei '^HTTP|www-auth'

# 2.3 tools/list with the exchanged token -> "tools":[{"name":"get_balance",…}]
mcp localhost:3001/mcp "$X" "$LIST"; echo

# 2.4 get_balance -> 200
#     "structuredContent":{"address":"0x7099…","wei":"9999…","ether":"9999.4…"}
#     (the exact value depends on how many times you seeded)
mcp localhost:3001/mcp "$X" "$(call get_balance)"; echo

# 2.5 Bad address
#     -> "isError":true, "…address must be 0x followed by 40 hex characters…"
mcp localhost:3001/mcp "$X" "$(call get_balance nope)"; echo

# 2.6 The MCP server checks the scope itself: token with only recon:read
#     -> "isError":true, "Tool get_balance requires scope chain:read"
XR=$(xchg "$A" chainaudit-mcp recon:read | at)
mcp localhost:3001/mcp "$XR" "$(call get_balance)"; echo

# 2.7 GET -> 405
curl -s -o /dev/null -w '%{http_code}\n' localhost:3001/mcp
```

### Task 4a: gateway

```bash
# 4a.1 Protected resource metadata, both URLs
#      -> {"resource":"http://localhost:3000/mcp",
#          "authorization_servers":["http://localhost:3002"],
#          "scopes_supported":["chain:read"],…}
curl -s localhost:3000/.well-known/oauth-protected-resource/mcp; echo
curl -s localhost:3000/.well-known/oauth-protected-resource; echo

# 4a.2 No token -> 401
#      WWW-Authenticate: Bearer
#        resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"
curl -s -i localhost:3000/mcp -H "$J" -H "$ACC" -d "$LIST" \
  | grep -Ei '^HTTP|www-auth'

# 4a.3 Tampered token -> 401, error_description="invalid signature"
mcp localhost:3000/mcp "${A}x" "$LIST" | grep -Ei '^HTTP|www-auth'

# 4a.4 HS256 token -> 401, error_description="algorithm not allowed"
HS=$(node --input-type=module -e 'import { SignJWT } from "jose"
console.log(await new SignJWT({ tenant_id: "acme", scope: "chain:read" })
  .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
  .setIssuer("http://localhost:3002").setAudience("chainaudit-gateway")
  .setSubject("x").setIssuedAt().setJti("j").setExpirationTime("5m")
  .sign(new TextEncoder().encode("guess")))')
mcp localhost:3000/mcp "$HS" "$LIST" | grep -Ei '^HTTP|www-auth'

# 4a.5 A token addressed to the MCP server -> 401, "unexpected audience"
mcp localhost:3000/mcp "$X" "$LIST" | grep -Ei '^HTTP|www-auth'

# 4a.6 tools/list -> 200, "tools":[{"name":"chain__get_balance",…}]
mcp localhost:3000/mcp "$A" "$LIST"; echo

# 4a.7 Call through the gateway as globex
#      -> "structuredContent":{"address":"0x7099…","wei":…,"ether":…}
G=$(tok agent-globex:globex-local-secret | at)
mcp localhost:3000/mcp "$G" "$(call chain__get_balance)"; echo

# 4a.8 acme with only recon:read
#      list -> "tools":[]
#      call -> "isError":true, "Tool chain__get_balance requires scope chain:read"
R=$(tok agent-acme:acme-local-secret recon:read | at)
mcp localhost:3000/mcp "$R" "$LIST"; echo
mcp localhost:3000/mcp "$R" "$(call chain__get_balance)"; echo

# 4a.9 Unknown tool -> "isError":true, "Unknown tool chain__nope"
mcp localhost:3000/mcp "$A" "$(call chain__nope)"; echo

# 4a.10 GET -> 405
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/mcp
```

### Task 2: timeouts and provider failures (Toxiproxy)

```bash
# F.1 Add 3 s latency, then call
#     -> after about 2 s (real ≈ 2.0–2.5s): "isError":true,
#        "Node provider timed out after 2000 ms"
curl -s -X POST localhost:8474/proxies/anvil/toxics \
  -d '{"name":"lag","type":"latency","attributes":{"latency":3000}}'; echo
time mcp localhost:3000/mcp "$A" "$(call chain__get_balance)"; echo
curl -s -X DELETE localhost:8474/proxies/anvil/toxics/lag

# F.2 Disable the proxy -> "isError":true, "Node provider unavailable"
curl -s -X POST localhost:8474/proxies/anvil -d '{"enabled":false}'; echo
mcp localhost:3000/mcp "$A" "$(call chain__get_balance)"; echo

# F.3 Re-enable -> the balance comes back
curl -s -X POST localhost:8474/proxies/anvil -d '{"enabled":true}'; echo
mcp localhost:3000/mcp "$A" "$(call chain__get_balance)"; echo
```

If a fault check is interrupted, reset Toxiproxy with the `DELETE` and `{"enabled":true}` commands above.

### Tasks 5a and 5b: tenant registry and egress

```bash
reg() { curl -s -w ' %{http_code}\n' localhost:3000/admin/targets \
  -H "Authorization: Bearer $1" -H "$J" -d "$2"; }
tgt() { printf '{"target_id":"%s","name":"%s","base_url":"%s","auth_type":"api_key","api_key":"%s"}' \
  "$1" "${4:-Client notes}" "$2" "$3"; }
names() { node -pe 'JSON.parse(require("fs").readFileSync(0)).result.tools.map(t => t.name).join(" ")'; }
NOTE_CALL='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notes__get_client_note","arguments":{"client_name":"Northwind Ltd"}}}'
ADMIN=$(tok acme-admin:acme-admin-local-secret | at)
AT=$(tok agent-acme:acme-local-secret | at)
G=$(tok agent-globex:globex-local-secret | at)

# 5a.1 Register -> {…,"secret_ref":"/tenants/acme/targets/notes","status":"active","version":2,…} 201 (200 if it exists)
reg "$ADMIN" "$(tgt notes http://localhost:3003/mcp acme-sample-key)"

# 5a.2 Same again -> same body, 200 ; different name -> {"error":"conflict",…} 409
reg "$ADMIN" "$(tgt notes http://localhost:3003/mcp acme-sample-key)"
reg "$ADMIN" "$(tgt notes http://localhost:3003/mcp acme-sample-key 'Another name')"

# 5a.3 Agent token -> {"error":"insufficient_scope",…} 403
reg "$AT" "$(tgt notes http://localhost:3003/mcp acme-sample-key)"

# 5a.4 Wrong key -> "status":"pending","status_reason":"health probe failed: rejected the credentials (HTTP 401)"
reg "$ADMIN" "$(tgt notes2 http://localhost:3003/mcp wrong-key-123 'Bad key')"

# 5a.5 Catalogs -> acme: "chain__get_balance notes__get_client_note" ; globex: "chain__get_balance"
mcp localhost:3000/mcp "$AT" "$LIST" | sed -n '$p' | names
mcp localhost:3000/mcp "$G" "$LIST" | sed -n '$p' | names

# 5a.6 Calls -> acme: "structuredContent":{"client_name":"Northwind Ltd","note":"Holds treasury in a 2-of-3 multisig;…"}
#              globex: "isError":true, "Unknown tool notes__get_client_note"
mcp localhost:3000/mcp "$AT" "$NOTE_CALL" | sed -n '$p'; echo
mcp localhost:3000/mcp "$G" "$NOTE_CALL" | sed -n '$p'; echo

# 5b.1 Each -> 400 with the reason shown
reg "$ADMIN" "$(tgt e1 http://127.0.0.1:3003/mcp k-123456)"          # base_url must use a hostname, not an IP address
reg "$ADMIN" "$(tgt e2 http://2130706433:3003/mcp k-123456)"         # same (decimal is canonicalised to 127.0.0.1)
reg "$ADMIN" "$(tgt e3 http://169.254.169.254/latest/ k-123456)"     # same (cloud metadata)
reg "$ADMIN" "$(tgt e4 https://example.com/mcp k-123456)"            # host example.com is not in the tenant's allowed domains
reg "$ADMIN" "$(tgt e5 http://user:pw@localhost:3003/mcp k-123456)"  # base_url must not contain credentials
```

The `mcp` helper prints headers too; `sed -n '$p'` keeps only the JSON body.

## 7. Manual checks (need logs or restarts)

**a. Trace propagation (task 4a).** After `pnpm verify`, find the gateway's last `"msg":"mcp request"` line with `"tool":"chain__get_balance"` and copy its `trace_id`. The MCP server terminal shows `"mcp request"` lines with that same `trace_id`. There are several, because each gateway call does initialize plus the call.

**b. Exchange cache (task 4b).** Make the same call through the gateway twice within 4 minutes:

```bash
TOKEN=$(curl -s -u agent-acme:acme-local-secret -d grant_type=client_credentials localhost:3002/oauth2/token | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
for i in 1 2; do curl -s localhost:3000/mcp -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"chain__get_balance","arguments":{"address":"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"}}}' >/dev/null; done
```

Expected:
- the gateway logs `"msg":"target token"` with `"exchange":"miss"`, then `"exchange":"hit"`;
- the issuer logs only one `"token exchanged"`;
- the MCP server's lines include `"tenant_id":"acme","sub":"agent-acme","act":"chainaudit-gateway"`.

**c. Signing key survives restarts (task 3).** Note the `kid` from `curl -s localhost:3002/.well-known/jwks.json`, restart `pnpm issuer:dev`, and check again. The `kid` is the same, and `ls -l .keys/` shows `-rw-------`.

**d. Issuer down gives 503, not 401 (task 4a).** Stop the issuer and restart the gateway so it has no cached keys. A call with a token you saved earlier returns `503 {"error":"temporarily_unavailable"}`. Start the issuer again afterwards.

**e. Wrong audience (task 4a).** Restart the issuer with `TOKEN_AUDIENCE=other pnpm issuer:dev` and fetch a new token. Calling the gateway with it returns 401 with `error_description="unexpected audience"`. Restart the issuer normally afterwards.

**f. Jaeger UI (task 1).** Open http://localhost:16686. It loads. No traces are expected yet, because OpenTelemetry instrumentation comes in a later task.

**g. MCP Inspector (task 2).** Run `npx @modelcontextprotocol/inspector`, choose Streamable HTTP, and enter `http://localhost:3000/mcp`. Paste a token from step 7b as the Bearer token (Inspector can't run the client credentials flow itself). Then list the tools and call `chain__get_balance`.

**h. Calls are pinned to validated IPs (task 5b).** After `pnpm verify` (or 5a.6), the gateway terminal shows, before each tenant call, `{"msg":"egress validated","target_id":"notes","connect_to":["::1","127.0.0.1"],…}`, and no `egress validation failed` line. Those are the only addresses the call may connect to.

**i. Production mode never allows private networks (task 5b).** Stop the gateway and start it in production mode, with the escape hatch set anyway:

```bash
APP_ENV=production EGRESS_ALLOW_PRIVATE_NETWORKS=true node src/apps/gateway/main.ts
```

- There's no `warn` line, and the listening line shows `"app_env":"production"`.
- Registering `http://localhost:3003/mcp` returns `400` with `"base_url must use https"`.
- Calling `notes__get_client_note` returns `isError` with `"Target notes failed egress validation"`, and the log shows the reason.

Restart with `pnpm gateway:dev` afterwards.

**j. Registry cache staleness (task 5a).** Within 30 s of the first acme `tools/list`, a target change in DynamoDB isn't visible to routing yet. After 30 s it is. That's the trade-off documented in `caching-target-reader.ts`.


## Stop everything

Stop the three services with Ctrl+C, then:

```bash
pnpm infra:down             # keeps the Postgres volume; add -v via docker compose to delete it (step 1)
```
