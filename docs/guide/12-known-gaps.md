# 12 · Known gaps and differences

> Every shortcut, simplification and code-vs-RFC difference in one place, with what a production version would need. "RFC" means `docs/rfc-001.md`. Items already recorded in the RFC's "What changed after building" are marked *(in RFC)*.

Acronyms used here:

- **IAM**: Identity and Access Management.
- **ABAC**: Attribute Based Access Control.
- **SLO**: Service Level Objective.
- **OTel**: OpenTelemetry.
- **CI**: Continuous Integration.

## Not built at all (design only)

| Item | RFC section | Production needs |
| --- | --- | --- |
| AWS deployment: AgentCore Gateway, Cognito, Lambda, Terraform | Local first strategy, build plan | The deployment itself, the cost controls first, then Cognito claims and AgentCore settings verified against AWS docs |
| Four of five MCP tools (`get_transactions`, `start_reconciliation`, `get_reconciliation_status`, `fetch_client_ledger`) | MCP server | Implementation and their scopes |
| Ingestion: EventBridge, poller, SQS, writer, DLQ, finality worker | Sync and async flows | Everything; PostgreSQL access code (no `pg` dependency yet) |
| Outbox publisher, reconciliation worker | Sync and async flows | Everything; the SQL is proven only in the hand-run lab |
| On-premise relay | On premise relay | Everything |
| OpenAPI specs and the CI breaking-change job | Contracts | Specs per target, a diff tool in CI |
| OTel spans, metrics, SLOs, burn-rate alerts | Contracts, observability and SLOs | An OTel SDK in each app, exporters, a dashboard, alerts |
| Retries, deadlines, bulkhead, rate limiting, degradation | Third party failure containment | All five; rate limiting waits on what AgentCore does natively (open RFC question) |
| Idempotency records in DynamoDB | Domain model | A table or item type, plus use in write tools |
| Per-tenant request quotas (rpm, in flight) *(in RFC)* | Tenant registry and isolation | Counters with TTL or AgentCore's native limits |

## Built, but simpler than the RFC

| Gap | Today | Production needs |
| --- | --- | --- |
| Circuit breaker parameters | 10 calls, 50%, 15 s, 1 probe | The RFC's 20 / 30 s / 3 probes or tuned values; "What changed" line pending approval |
| Breaker state | In memory per gateway process | Transitions shared through DynamoDB (RFC) |
| Breaker check placement | After registry, scope, DNS and secret reads | Check earlier to save local work when open |
| Registration probe | Bypasses the breaker, uses the 5 s default timeout | Same timeout as calls; periodic re-probe; a `disabled` API |
| Timeouts | Fixed (2 s tenant, 5 s platform) | Caller's remaining deadline propagated and enforced |
| Credentials | Files in `.secrets/`, code-level tenant check | Secrets Manager, tagged, with IAM ABAC via STS session tags |
| Registry access control | Code always uses the caller's tenant in the key | IAM `dynamodb:LeadingKeys` condition (verify in AWS docs) |
| Allowed domains | Set only by `pnpm setup:dynamodb` | An operator or admin API with review |
| Target auth types | `api_key` only | OAuth client credentials and others, via credential providers |
| Token issuer | Local issuer, `clients.json`, key in `.keys/` | Cognito (with the claim differences *(in RFC)*), or a managed IdP; key rotation |
| Audience values | Logical names (`chainaudit-gateway`) | The MCP spec expects the canonical server URI (RFC 8707); proposed, not in RFC |
| Token exchange | Local RFC 8693 implementation | Cognito lacks it *(proposed, verify in AWS docs)*; AgentCore Identity outbound auth |
| Tracing | `traceparent` header + `trace_id` in logs | OTel spans to X-Ray/Jaeger; `correlation_id`; `target_id` on every line |
| Egress | HTTPS + allowlist + public IPs + pinning in code; local mode allows http to loopback/private | Network-level egress controls as well (verify in AWS docs) |
| Gateway → target cost | New MCP client per call (about 4 HTTP requests per tool call) | Client or session reuse per target, or cached tool lists |
| Registry cache | 30 s TTL, no invalidation across instances | Shorter TTL or explicit invalidation for kill switches |

## Differences from the RFC that are deliberate additions

- **Stricter token verification.** The algorithm is pinned (ES256), `typ: at+jwt` is required, and so are a set of claims.
- **Stricter token exchange.** Only the subject token's audience may exchange it, an `act` claim is added, re-exchange is refused, and the new `exp` is capped at the subject's.
- **More blocked ranges.** IP literals in any notation, CGNAT, NAT64, 6to4, Teredo, multicast, reserved and IPv4-mapped IPv6 are all blocked.
- **Separate tenant scope.** `tenant:tools` covers all tools of a caller's own tenant targets.
- **Breakers for platform targets too,** one per tenant.
- **Tenant targets get an API key, never tokens** *(in RFC)*.
- **The quota is enforced by a DynamoDB transaction** *(in RFC)*.
- **The SQL lab writes idempotent job creation as a single CTE statement,** where the RFC uses `BEGIN … COMMIT`. Both are atomic.

## Engineering hygiene gaps

- **Recent transitive dependencies.** Some packages pulled in by the direct dependencies (e.g. `@aws-sdk/*`, `@smithy/*`) are newer than two weeks. A pnpm `minimumReleaseAge` setting was proposed, not applied.
- **No CI.** Checks run by hand (`pnpm verify`).
- **Docker Desktop dependency.** `host.docker.internal` reaching services that listen on the host's 127.0.0.1 works on your Mac. On Linux the compose file adds `host-gateway`, but this hasn't been tested there.
- **Mixed diagram numbering.** `docs/diagrams/` has two files numbered 02 (`02-tenant-targets.md`, `02-registry-and-resilience.md`).
- **One-line README.** The repository README was a single line before this guide.
