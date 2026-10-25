#!/usr/bin/env bash
# End-to-end checks for everything built so far (tasks 1 to 4b).
# Prerequisites: infra up, Anvil seeded, and issuer, MCP server and gateway
# running. See docs/verify.md. This script never starts or stops services; it
# only adds and removes a Toxiproxy toxic during the fault checks.
#
# Usage: pnpm verify            (or: bash scripts/verify.sh)
#        pnpm verify --no-faults (skip the Toxiproxy fault-injection checks)

set -u
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f infra/docker-compose.yml"
ISSUER=http://localhost:3002
MCP=http://localhost:3001/mcp
GATEWAY=http://localhost:3000
TOXI=http://localhost:8474
ADDRESS=0x70997970C51812dc3A010C7d01b50e0d17dc79C8 # Anvil account #1
TE=urn:ietf:params:oauth:grant-type:token-exchange
AT=urn:ietf:params:oauth:token-type:access_token
RUN_FAULTS=1
[[ "${1:-}" == "--no-faults" ]] && RUN_FAULTS=0

TMP=$(mktemp -d)
PASS=0
FAIL=0

cleanup() {
  # Leave Toxiproxy clean even if a check fails halfway.
  curl -s -o /dev/null -X DELETE "$TOXI/proxies/anvil/toxics/verify_lag" 2>/dev/null
  curl -s -o /dev/null -X POST "$TOXI/proxies/anvil" -d '{"enabled":true}' 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---------- helpers ----------
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
fail() {
  printf '  \033[31mFAIL\033[0m %s\n       expected: %s\n       got:      %s\n' "$1" "$2" "${3:0:300}"
  FAIL=$((FAIL + 1))
}
expect_eq() { if [[ "$3" == "$2" ]]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
expect_has() { if [[ "$3" == *"$2"* ]]; then pass "$1"; else fail "$1" "contains '$2'" "$3"; fi; }

# js '<expr over j>' evaluates a JavaScript expression on JSON read from stdin.
js() {
  node -e '
    let s = ""
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j; try { j = JSON.parse(s) } catch { j = undefined }
      let v; try { v = new Function("j", "return (" + process.argv[1] + ")")(j) } catch { v = undefined }
      console.log(typeof v === "string" ? v : JSON.stringify(v))
    })' "$1"
}

# req <curl args...> sets STATUS, TIME, BODY and HEADERS.
req() {
  local out
  out=$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code} %{time_total}' --max-time 15 "$@")
  STATUS=${out% *}
  TIME=${out#* }
  BODY=$(cat "$TMP/body" 2>/dev/null)
  HEADERS=$(cat "$TMP/headers" 2>/dev/null)
}
header() { printf '%s' "$HEADERS" | grep -i "^$1:" | head -1 | cut -d' ' -f2- | tr -d '\r'; }

token() { # token <client:secret> [scope]
  local args=(-s -u "$1" -d grant_type=client_credentials)
  [[ -n "${2:-}" ]] && args+=(--data-urlencode "scope=$2")
  curl "${args[@]}" "$ISSUER/oauth2/token" | js 'j.access_token'
}
exchange() { # exchange <subject token> <audience> <scope>  (sets STATUS/BODY)
  req -u chainaudit-gateway:gateway-local-secret -d "grant_type=$TE" -d "subject_token_type=$AT" \
    --data-urlencode "subject_token=$1" -d "audience=$2" --data-urlencode "scope=$3" "$ISSUER/oauth2/token"
}
claims() { node -e 'console.log(Buffer.from(process.argv[1].split(".")[1] ?? "", "base64url").toString())' "$1"; }
jwt_header() { node -e 'console.log(Buffer.from(process.argv[1].split(".")[0] ?? "", "base64url").toString())' "$1"; }
rpc() { # rpc <url> <bearer or ""> <json body>
  local auth=()
  [[ -n "$2" ]] && auth=(-H "Authorization: Bearer $2")
  req "$1" ${auth[@]+"${auth[@]}"} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$3"
}
call_body() { printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"%s","arguments":{"address":"%s"}}}' "$1" "${2:-$ADDRESS}"; }
LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
text_of() { printf '%s' "$1" | js 'j.result.content[0].text'; }

# ---------- preflight ----------
section "Preflight"
missing=0
for svc in "Anvil:8545" "Toxiproxy:8474" "DynamoDB:8000" "Issuer:3002" "MCP server:3001" "Gateway:3000"; do
  name=${svc%:*}; port=${svc##*:}
  if nc -z localhost "$port" 2>/dev/null; then pass "$name listening on $port"; else fail "$name listening on $port" "port open" "closed"; missing=1; fi
done
if [[ $missing == 1 ]]; then
  printf '\nSome services are not running. Follow docs/verify.md, steps 3 to 5, then run this again.\n'
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
expect_eq "Node major version matches .nvmrc" "$(cat .nvmrc)" "$NODE_MAJOR"
if pnpm -s typecheck >"$TMP/tsc" 2>&1; then pass "pnpm typecheck"; else fail "pnpm typecheck" "exit 0" "$(cat "$TMP/tsc")"; fi

# ---------- task 1: infrastructure ----------
section "Task 1: local infrastructure"
req -X POST localhost:8000 -H 'Content-Type: application/x-amz-json-1.0' -H 'X-Amz-Target: DynamoDB_20120810.ListTables' \
  -H 'Authorization: AWS4-HMAC-SHA256 Credential=local/20260101/us-east-1/dynamodb/aws4_request, SignedHeaders=host, Signature=x' -d '{}'
expect_has "DynamoDB Local answers ListTables" '"TableNames"' "$BODY"
expect_has "PostgreSQL 17.11 answers" "PostgreSQL 17.11" "$($COMPOSE exec -T postgres psql -U chainaudit -tAc 'select version()' 2>&1)"
CHAIN='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
req -X POST localhost:8545 -H 'Content-Type: application/json' -d "$CHAIN"
expect_eq "Anvil direct: chain id 31337 (0x7a69)" "0x7a69" "$(printf '%s' "$BODY" | js 'j.result')"
req -X POST localhost:18545 -H 'Content-Type: application/json' -d "$CHAIN"
expect_eq "Anvil through Toxiproxy: chain id 0x7a69" "0x7a69" "$(printf '%s' "$BODY" | js 'j.result')"
req "$TOXI/proxies"
expect_eq "Toxiproxy proxy anvil -> anvil:8545, enabled, no toxics" "anvil:8545 true 0" \
  "$(printf '%s' "$BODY" | js '`${j.anvil.upstream} ${j.anvil.enabled} ${j.anvil.toxics.length}`')"
req localhost:16686
expect_eq "Jaeger UI responds" "200" "$STATUS"
req -X POST localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[]}'
expect_eq "Jaeger accepts OTLP over HTTP" "200" "$STATUS"

# ---------- task 3: token issuer ----------
section "Task 3: token issuer"
req "$ISSUER/.well-known/jwks.json"
expect_eq "JWKS has one public ES256 P-256 key with kid and no private part" "true" \
  "$(printf '%s' "$BODY" | js 'j.keys.length===1 && j.keys[0].kty==="EC" && j.keys[0].crv==="P-256" && j.keys[0].alg==="ES256" && !!j.keys[0].kid && !("d" in j.keys[0])')"
req -u agent-acme:acme-local-secret -d grant_type=client_credentials --data-urlencode 'scope=chain:read recon:read' "$ISSUER/oauth2/token"
expect_eq "client_credentials -> 200 Bearer, 900 s, requested scope" "200 Bearer 900 chain:read recon:read" \
  "$STATUS $(printf '%s' "$BODY" | js '`${j.token_type} ${j.expires_in} ${j.scope}`')"
expect_eq "token response is not cacheable" "no-store" "$(header Cache-Control)"
A=$(printf '%s' "$BODY" | js 'j.access_token')
expect_eq "agent token header: ES256, typ at+jwt, kid" "ES256 at+jwt true" \
  "$(jwt_header "$A" | js '`${j.alg} ${j.typ} ${!!j.kid}`')"
expect_eq "agent token claims: iss, aud gateway, sub, tenant, 15 min, jti" \
  "http://localhost:3002 chainaudit-gateway agent-acme acme 900 true" \
  "$(claims "$A" | js '`${j.iss} ${j.aud} ${j.sub} ${j.tenant_id} ${j.exp-j.iat} ${!!j.jti}`')"
req -u agent-acme:acme-local-secret -d grant_type=client_credentials "$ISSUER/oauth2/token"
expect_eq "no scope -> every allowed scope" "chain:read recon:read recon:write" "$(printf '%s' "$BODY" | js 'j.scope')"
req -u agent-globex:globex-local-secret -d grant_type=client_credentials -d scope=recon:write "$ISSUER/oauth2/token"
expect_eq "scope not allowed -> 400 invalid_scope" "400 invalid_scope" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
req -u agent-acme:wrong -d grant_type=client_credentials "$ISSUER/oauth2/token"
WRONG="$STATUS $(printf '%s' "$BODY" | js 'j.error_description')"
expect_eq "wrong secret -> 401 invalid_client" "401 invalid_client" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
expect_has "401 carries WWW-Authenticate Basic" "Basic" "$(header WWW-Authenticate)"
req -u nobody:x -d grant_type=client_credentials "$ISSUER/oauth2/token"
expect_eq "unknown client -> same answer as wrong secret" "$WRONG" "$STATUS $(printf '%s' "$BODY" | js 'j.error_description')"
req -u agent-acme:acme-local-secret -d grant_type=password "$ISSUER/oauth2/token"
expect_eq "unsupported grant -> 400 unsupported_grant_type" "400 unsupported_grant_type" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
req -u agent-acme:acme-local-secret "$ISSUER/oauth2/token" -d scope=chain:read
expect_eq "missing grant_type -> 400 invalid_request" "400 invalid_request" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"

# ---------- task 4b: token exchange ----------
section "Task 4b: token exchange (RFC 8693)"
exchange "$A" chainaudit-mcp chain:read
expect_eq "exchange -> 200, access_token type, 300 s, scope chain:read" "200 $AT 300 chain:read" \
  "$STATUS $(printf '%s' "$BODY" | js '`${j.issued_token_type} ${j.expires_in} ${j.scope}`')"
X=$(printf '%s' "$BODY" | js 'j.access_token')
expect_eq "exchanged claims: aud target, sub and tenant copied, act gateway, 5 min" \
  "chainaudit-mcp agent-acme acme chainaudit-gateway 300" \
  "$(claims "$X" | js '`${j.aud} ${j.sub} ${j.tenant_id} ${j.act?.sub} ${j.exp-j.iat}`')"
exchange "$A" chainaudit-mcp recon:write
expect_eq "scope the subject lacks -> 400 invalid_scope" "400 invalid_scope" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
exchange "$A" some-other-service chain:read
expect_eq "audience not allowed -> 400 invalid_target" "400 invalid_target" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
exchange "$X" chainaudit-mcp chain:read
expect_eq "re-exchanging an exchanged token -> 400 invalid_request" "400 invalid_request" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
req -u agent-acme:acme-local-secret -d "grant_type=$TE" "$ISSUER/oauth2/token"
expect_eq "agent may not exchange -> 400 unauthorized_client" "400 unauthorized_client" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"
req -u chainaudit-gateway:gateway-local-secret -d grant_type=client_credentials "$ISSUER/oauth2/token"
expect_eq "gateway may not get its own token -> 400 unauthorized_client" "400 unauthorized_client" "$STATUS $(printf '%s' "$BODY" | js 'j.error')"

# ---------- task 2 + 4b: MCP server ----------
section "Tasks 2 and 4b: MCP server (direct)"
rpc "$MCP" "" "$(call_body get_balance)"
expect_eq "no token -> 401" "401" "$STATUS"
rpc "$MCP" "$A" "$(call_body get_balance)"
expect_eq "agent token (aud gateway) -> 401" "401" "$STATUS"
expect_has "rejected for its audience: no passthrough" "unexpected audience" "$(header WWW-Authenticate)"
rpc "$MCP" "$X" "$LIST"
expect_eq "tools/list -> get_balance" '["get_balance"]' "$(printf '%s' "$BODY" | js 'j.result.tools.map(t => t.name)')"
rpc "$MCP" "$X" "$(call_body get_balance)"
expect_eq "get_balance -> wei and ether as decimal strings" "true" \
  "$(printf '%s' "$BODY" | js '/^\d+$/.test(j.result.structuredContent.wei) && /^\d+(\.\d+)?$/.test(j.result.structuredContent.ether)')"
ETHER=$(printf '%s' "$BODY" | js 'j.result.structuredContent.ether')
if [[ "$ETHER" != "10000" ]]; then pass "account #1 changed from 10000 ETH, so Anvil was seeded ($ETHER ETH)"; else fail "Anvil was seeded" "balance != 10000" "10000 (run pnpm seed:anvil)"; fi
rpc "$MCP" "$X" "$(call_body get_balance nope)"
expect_has "bad address -> isError with a clear message" "address must be 0x followed by 40 hex characters" "$BODY"
exchange "$A" chainaudit-mcp recon:read
XR=$(printf '%s' "$BODY" | js 'j.access_token')
rpc "$MCP" "$XR" "$(call_body get_balance)"
expect_eq "MCP server re-checks scope (defense in depth)" "Tool get_balance requires scope chain:read" "$(text_of "$BODY")"
req "$MCP"
expect_eq "GET /mcp -> 405 (stateless, no SSE stream)" "405" "$STATUS"

# ---------- task 4a: gateway ----------
section "Task 4a: gateway"
req "$GATEWAY/.well-known/oauth-protected-resource/mcp"
expect_eq "protected resource metadata (path URL)" "http://localhost:3000/mcp http://localhost:3002" \
  "$(printf '%s' "$BODY" | js '`${j.resource} ${j.authorization_servers[0]}`')"
req "$GATEWAY/.well-known/oauth-protected-resource"
expect_eq "protected resource metadata (root URL)" "http://localhost:3000/mcp" "$(printf '%s' "$BODY" | js 'j.resource')"
rpc "$GATEWAY/mcp" "" "$LIST"
expect_eq "no token -> 401" "401" "$STATUS"
expect_has "401 points to the resource metadata" 'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"' "$(header WWW-Authenticate)"
rpc "$GATEWAY/mcp" "${A}x" "$LIST"
expect_has "tampered token -> invalid signature" "invalid signature" "$(header WWW-Authenticate)"
HS=$(node --input-type=module -e 'import { SignJWT } from "jose"; console.log(await new SignJWT({ tenant_id: "acme", scope: "chain:read" }).setProtectedHeader({ alg: "HS256", typ: "at+jwt" }).setIssuer("http://localhost:3002").setAudience("chainaudit-gateway").setSubject("x").setIssuedAt().setJti("j").setExpirationTime("5m").sign(new TextEncoder().encode("guess")))')
rpc "$GATEWAY/mcp" "$HS" "$LIST"
expect_has "HS256 token -> algorithm not allowed" "algorithm not allowed" "$(header WWW-Authenticate)"
rpc "$GATEWAY/mcp" "$X" "$LIST"
expect_has "token addressed to the MCP server is refused by the gateway" "unexpected audience" "$(header WWW-Authenticate)"
rpc "$GATEWAY/mcp" "$A" "$LIST"
expect_eq "tools/list -> namespaced chain__get_balance" '["chain__get_balance"]' "$(printf '%s' "$BODY" | js 'j.result.tools.map(t => t.name)')"
G=$(token agent-globex:globex-local-secret)
rpc "$GATEWAY/mcp" "$G" "$(call_body chain__get_balance)"
expect_eq "tools/call through gateway (globex) -> balance" "$ADDRESS" "$(printf '%s' "$BODY" | js 'j.result.structuredContent.address')"
R=$(token agent-acme:acme-local-secret recon:read)
rpc "$GATEWAY/mcp" "$R" "$LIST"
expect_eq "recon:read only -> catalog is empty" "[]" "$(printf '%s' "$BODY" | js 'j.result.tools.map(t => t.name)')"
rpc "$GATEWAY/mcp" "$R" "$(call_body chain__get_balance)"
expect_eq "recon:read only -> call refused with required scope" "Tool chain__get_balance requires scope chain:read" "$(text_of "$BODY")"
rpc "$GATEWAY/mcp" "$A" "$(call_body chain__nope)"
expect_eq "unknown tool -> isError" "Unknown tool chain__nope" "$(text_of "$BODY")"
req "$GATEWAY/mcp"
expect_eq "GET /mcp -> 405" "405" "$STATUS"

# ---------- task 2: failure containment ----------
if [[ $RUN_FAULTS == 1 ]]; then
  section "Task 2: timeouts and provider failures (Toxiproxy)"
  curl -s -o /dev/null -X POST "$TOXI/proxies/anvil/toxics" -d '{"name":"verify_lag","type":"latency","attributes":{"latency":3000}}'
  rpc "$GATEWAY/mcp" "$A" "$(call_body chain__get_balance)"
  expect_eq "3 s provider latency -> clean timeout error" "Node provider timed out after 2000 ms" "$(text_of "$BODY")"
  expect_eq "answered within the 2 s timeout plus overhead (not 3 s)" "true" "$(node -p "$TIME >= 1.9 && $TIME < 3")"
  curl -s -o /dev/null -X DELETE "$TOXI/proxies/anvil/toxics/verify_lag"
  curl -s -o /dev/null -X POST "$TOXI/proxies/anvil" -d '{"enabled":false}'
  rpc "$GATEWAY/mcp" "$A" "$(call_body chain__get_balance)"
  expect_eq "provider down -> clean unavailable error" "Node provider unavailable" "$(text_of "$BODY")"
  curl -s -o /dev/null -X POST "$TOXI/proxies/anvil" -d '{"enabled":true}'
  rpc "$GATEWAY/mcp" "$A" "$(call_body chain__get_balance)"
  expect_eq "provider back -> balance again" "$ADDRESS" "$(printf '%s' "$BODY" | js 'j.result.structuredContent?.address')"
fi

# ---------- summary ----------
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$PASS" "$FAIL"
printf 'Manual checks (logs, restarts) are listed in docs/verify.md, step 7.\n'
[[ $FAIL == 0 ]]
