# ChainAudit Agent Gateway

A practice build of an **agent integration layer**, made to explain every design decision out loud in a technical interview.

The scenario was invented for practice before a **Caseware** interview, so it isn't a description of Caseware's real products. There are three roles:

| Role | Who | In this repo |
| --- | --- | --- |
| Platform operator ("we") | **Caseware** | Runs the gateway, token issuer, MCP server, registry and credential store |
| Tenants | **Audit and accounting firms, Caseware's customers** | `acme` and `globex`: their AI agents, admins and their own MCP servers |
| Audit clients | **Companies an audit firm audits** (the firm's clients) | Data only: wallets, ledgers, engagements (`Northwind Ltd`) |

Each audit firm's AI agents need MCP (Model Context Protocol) tools to read their audit clients' wallet balances on an EVM (Ethereum Virtual Machine) chain, and to call servers the firm runs itself. This repo builds Caseware's layer in between, locally:

- a gateway with inbound JWT (JSON Web Token) auth and per-tool scopes;
- token exchange on every hop;
- a tenant-isolated target registry with egress protection;
- a per-tenant circuit breaker.

The rest of the design (AWS AgentCore deployment, async reconciliation, on-premise relay) is in [`docs/rfc-001.md`](docs/rfc-001.md) and is **design only**.

## Status

| Component | Status | Where |
| --- | --- | --- |
| Token issuer (client credentials, RFC 8693 exchange, JWKS) | Built | `src/apps/token-issuer`, `src/core/issuer` |
| Gateway (auth, scopes, catalog, routing, admin API) | Built | `src/apps/gateway`, `src/core/gateway` |
| MCP server, `get_balance` | Built | `src/apps/mcp-server`, `src/core/balance` |
| Tenant sample server, `get_client_note` | Built | `src/apps/tenant-sample-server` |
| Tenant registry (DynamoDB Local) | Built | `src/adapters/aws/dynamodb-tenant-registry.ts`, `src/core/registry` |
| Tenant credentials (local files) | Built (local stand-in) | `src/adapters/local/file-credential-provider.ts` |
| Egress validation, DNS pinning | Built | `src/core/egress`, `src/adapters/local/mcp-target-client.ts` |
| Circuit breaker per tenant + target | Built (minimal) | `src/core/resilience` |
| Chaos (Toxiproxy), verify script | Built | `scripts/chaos.ts`, `scripts/verify.sh` |
| SQL lab | Run by hand | `docs/sql-lab.sql` |
| AWS deployment (AgentCore, Cognito, Lambda, Terraform) | Design only | RFC |
| SQS ingestion, outbox publisher, reconciliation worker | Design only | RFC |
| On-premise relay | Design only | RFC |
| OpenAPI contracts, OpenTelemetry spans, SLOs | Design only | RFC |
| Retries, bulkhead, rate limiting, degradation | Design only | RFC |

## Job responsibilities → where they're covered

| Responsibility | Chapter | Status |
| --- | --- | --- |
| AgentCore Gateway layer and its targets | [04](docs/guide/04-tenants-and-registry.md), [06](docs/guide/06-aws-agentcore.md) | Built locally; AWS design only |
| Tenant target registry: isolation, credentials, allowlisting, egress control, third party failure containment | [04](docs/guide/04-tenants-and-registry.md), [05](docs/guide/05-failure-containment.md) | Built (credentials as local files) |
| Inbound surface for external agents: authentication, scopes, rate limiting | [03](docs/guide/03-identity-chain.md) | Auth and scopes built; rate limiting design only |
| On-premise connectivity: session lifecycle, correlation, recovery | [07](docs/guide/07-on-premise-relay.md) | Design only |
| Identity and scope propagation across hops | [03](docs/guide/03-identity-chain.md) | Built locally |
| OpenAPI contracts and versioning | [09](docs/guide/09-contracts-and-observability.md) | Design only (MCP tool rules applied) |
| Outbound authorization: IAM, SigV4, OAuth, credential providers | [03](docs/guide/03-identity-chain.md), [04](docs/guide/04-tenants-and-registry.md), [06](docs/guide/06-aws-agentcore.md) | OAuth exchange and API keys built; IAM and SigV4 design only |
| Tracing and SLOs | [09](docs/guide/09-contracts-and-observability.md) | `traceparent` + log `trace_id` built; spans and SLOs design only |

## Local version → what you would use in the real world

| Local in this repo | Real-world service |
| --- | --- |
| `src/apps/gateway` | Amazon Bedrock AgentCore Gateway |
| Gateway outbound credentials (token exchange, API keys) | AgentCore Identity credential providers (verify in AWS docs) |
| `src/apps/token-issuer` | Amazon Cognito (or Auth0, Okta, Keycloak) |
| Apps run with `node` + Express | AWS Lambda |
| DynamoDB Local | Amazon DynamoDB |
| `.secrets/` files + code tenant check | AWS Secrets Manager + IAM ABAC via STS session tags |
| Anvil | A node provider (Alchemy, Infura, QuickNode) or your own node |
| Toxiproxy | AWS Fault Injection Service for experiments; real failures in production |
| PostgreSQL in Docker | Amazon Aurora Serverless v2 PostgreSQL (Data API) |
| Jaeger + OTLP | AWS X-Ray / CloudWatch via AWS Distro for OpenTelemetry |
| JSON logs on stdout | Amazon CloudWatch Logs |
| Scripts / timers (design only) | Amazon EventBridge Scheduler |
| SQS emulator (design only) | Amazon SQS + Lambda event source + DLQ |
| `ws` relay (design only) | Amazon API Gateway WebSocket API |
| `docker compose` | Terraform (for AWS) |

## Run it in five steps

Prerequisites: Docker Desktop, Node 24 (`.nvmrc`), and pnpm via corepack. Details in [chapter 02](docs/guide/02-services.md) and [`docs/verify.md`](docs/verify.md).

1. `pnpm install`
2. `pnpm infra:up && pnpm setup:dynamodb && pnpm seed:anvil`
3. In separate terminals, in this order: `pnpm issuer:dev`, `pnpm mcp:dev`, `pnpm tenant-sample:dev`, `pnpm gateway:dev`. Add `pnpm tenant-sample-globex:dev` for the breaker demo.
4. `pnpm verify`. Every line should be PASS.
5. Chaos demo: `pnpm chaos add acme-notes` and watch the breaker open in the gateway log (`docs/verify.md`, step 7k), then `pnpm chaos remove acme-notes`.

Also available: `pnpm test` (core unit tests with fakes), `pnpm typecheck`, `pnpm infra:ps`, `pnpm infra:down`.

## Learning guide

- [00 · Glossary](docs/guide/00-glossary.md)
- [01 · Big picture](docs/guide/01-big-picture.md)
- [02 · Services](docs/guide/02-services.md)
- [03 · Identity chain](docs/guide/03-identity-chain.md)
- [04 · Tenants and registry](docs/guide/04-tenants-and-registry.md)
- [05 · Failure containment](docs/guide/05-failure-containment.md)
- [06 · AWS and AgentCore](docs/guide/06-aws-agentcore.md) (design only)
- [07 · On-premise relay](docs/guide/07-on-premise-relay.md) (design only)
- [08 · Data and async](docs/guide/08-data-and-async.md) (design only + SQL lab)
- [09 · Contracts and observability](docs/guide/09-contracts-and-observability.md)
- [10 · Code tour](docs/guide/10-code-tour.md)
- [11 · How it was built with AI](docs/guide/11-how-it-was-built-with-ai.md)
- [12 · Known gaps](docs/guide/12-known-gaps.md)
- [13 · Interview review](docs/guide/13-interview-review.md)

Other docs:

- [`docs/rfc-001.md`](docs/rfc-001.md): the design, and what changed after building.
- [`docs/verify.md`](docs/verify.md): the runbook.
- [`docs/sql-lab.sql`](docs/sql-lab.sql): the SQL exercises.
- [`docs/diagrams/`](docs/diagrams/): snapshots drawn from the code. Start with [`03-end-to-end-flows.md`](docs/diagrams/03-end-to-end-flows.md): 16 detailed flows told with Caseware, acme, globex and Northwind.
- [`CLAUDE.md`](CLAUDE.md): the rules for the AI agent.
