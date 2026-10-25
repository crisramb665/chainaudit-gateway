# ChainAudit Agent Gateway

Practice project to prepare a technical interview. The spec is `docs/rfc-001.md` and it is the source of truth. Before any task, read the RFC sections that task touches.

## How we work

1. One task at a time, taken from the build plan in the RFC. Start every task in plan mode and wait for my approval before writing code.
2. If the RFC and reality disagree (an API works differently, a library lacks a feature, an assumption was wrong), stop and tell me. Propose a one line entry for the "What changed after building" section. Never deviate silently.
3. I run and verify everything myself. Do not start Docker, servers or test suites unless I ask. At the end of each task, give me the exact commands to verify it and what output to expect.
4. Never add a dependency without telling me its name, exact version and why. Pin exact versions, and pick versions published at least two weeks ago.
5. Keep changes small and suggest a commit message at the end of each task.
6. Do not write code for tasks that are not the current one, even if it seems convenient.

## Stack

- Node.js 24, TypeScript 5.9 in strict mode, ESM modules, pnpm.
- `@modelcontextprotocol/sdk` 1.x (not the v2 split packages).
- zod 4, viem, jose, express 5, pg, AWS SDK v3 clients, vitest.
- Development machine is an Apple Silicon Mac: every Docker image must support arm64.

## Architecture rules

- Ports and adapters. `src/core` holds domain logic and port interfaces and never imports AWS SDKs, HTTP frameworks or database drivers. Adapters live in `src/adapters/local` and `src/adapters/aws`. Runnable entry points live in `src/apps`.
- Switching between local and AWS adapters is configuration, never code changes in `src/core`.
- Handlers are plain functions that take an event and return a result, so the same handler runs behind Express locally and inside Lambda later.
- `tenant_id` always comes from verified token claims, never from tool input or request bodies.
- Every outbound call has an explicit timeout.
- MCP server: Streamable HTTP in stateless mode, a new server and transport per request.
- Tool failures return an MCP result with `isError: true` and a clear message. Raw errors never reach the agent.
- Logs are structured JSON and always include `trace_id` and, when known, `tenant_id`.
- No token is forwarded to the next hop. Each hop validates what it receives.

## Layout

```
docs/rfc-001.md          spec, source of truth
src/core/                domain, ports, policies (breaker, retries)
src/adapters/local/      DynamoDB Local, Postgres, local issuer, Anvil
src/adapters/aws/        Cognito, DynamoDB, Secrets Manager, SQS
src/apps/mcp-server/     MCP server entry point
src/apps/gateway/        own gateway: auth, scopes, routing
src/apps/token-issuer/   local OAuth issuer with JWKS
src/apps/workers/        ingestion and reconciliation workers
scripts/                 seeding and helper scripts
infra/                   docker compose and, later, Terraform
```

## Local services

| Service | Port |
| --- | --- |
| Anvil (direct) | 8545 |
| Anvil through Toxiproxy (use this one from the app) | 18545 |
| Toxiproxy API | 8474 |
| DynamoDB Local | 8000 |
| PostgreSQL | 5432 |
| Jaeger UI | 16686 |
| OpenTelemetry collector (OTLP over HTTP) | 4318 |

## Comments

This is a learning project. Add comments that explain the concept behind the code, not what the line does:
why this pattern is used, what problem it prevents and what would break without it.
Example: on a circuit breaker transition, explain why half open allows only a few probes.
Mark these comments with `// LEARN:` so they can be found or removed later.

## Commands

To be filled as the project grows.
