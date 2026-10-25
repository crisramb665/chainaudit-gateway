# ChainAudit Agent Gateway

Practice project to prepare a technical interview. The spec is `docs/rfc-001.md` and it is the source of truth. Before any task, read the RFC sections that task touches.

## How we work

1. One task at a time, taken from the build plan in the RFC. Start every task in plan mode and wait for my approval before writing code.
2. If the RFC and reality disagree (an API works differently, a library lacks a feature, an assumption was wrong), stop and tell me. Propose a one line entry for the "What changed after building" section. Never deviate silently.
3. I run and verify everything myself. Do not start Docker, servers or test suites unless I ask. At the end of each task, give me the exact commands to verify it and what output to expect.
4. Never add a dependency without telling me its name, exact version and why. Pin exact versions, and pick versions published at least two weeks ago.
5. Keep changes small and suggest a commit message at the end of each task.
6. Do not write code for tasks that are not the current one, even if it seems convenient.
7. At the end of each task, list which parts of docs/rfc-001.md the task affected: open questions it answered, assumptions it proved wrong. Propose the exact text for each change and wait for my approval before editing the RFC. Never edit files in docs/diagrams/; they are snapshots.

## Stack

- Node.js 24, TypeScript 5.9 in strict mode, ESM modules, pnpm.
- `@modelcontextprotocol/sdk` 1.x (not the v2 split packages).
- zod 4, viem, jose, express 5, pg, AWS SDK v3 clients, vitest.
- Development machine is an Apple Silicon Mac: every Docker image must support arm64.

## Architecture rules

- Ports and adapters. `src/core` holds domain logic and port interfaces and never imports AWS SDKs, HTTP frameworks or database drivers. Adapters live in `src/adapters/local` and `src/adapters/aws`. Runnable entry points live in `src/apps`.
- Switching between local and AWS adapters is configuration, never code changes in `src/core`.
- Dependency injection by hand, no DI framework or container. Every adapter, service and HTTP handler is a class that receives its dependencies through the constructor, typed by an interface, never by a concrete class.
- Driven ports (what core needs from outside: `TokenVerifier`, `BalanceReader`, `TokenExchanger`, `Clock`, …) are interfaces in `src/core/ports`. Service interfaces that apps call into core (`BalanceService`, `GatewayService`, `TokenIssuer`) live in `src/core` next to their `Default*` implementation. Add a port only where code would otherwise depend directly on a library or infrastructure.
- Constructor arguments are long-lived dependencies; request-scoped values (principal, request logger, traceparent) are method arguments, never fields.
- Nothing calls `new` on its own dependencies. Objects needed per request (MCP servers, transports) come from an injected factory. An adapter may build its own library client (viem, fetch, the MCP SDK client) from config values, since that client is its implementation.
- No module-level singletons. `src/core` never imports adapters or apps, and no app imports another app (shared app code lives in `src/apps/shared`).
- Each application has exactly one composition root, `src/apps/<app>/main.ts`. It is the only place that reads configuration, instantiates concrete adapters and wires the graph, in dependency order. Scripts in `scripts/` are their own small composition roots.
- Configuration is parsed and validated once with zod (`parseConfig(process.env)` in `main.ts`) and passed down as narrow typed values. Nothing else reads `process.env`.
- Handlers are classes whose dependencies come through the constructor. Their entry method takes an event and returns a result where the protocol allows it (the token endpoint does), so the same handler can run behind Express locally and inside Lambda later; the MCP handlers take Node req/res because the SDK transport needs them.
- Core services are unit-tested with hand-written fakes of their ports (`pnpm test`); no mocking library, network or Docker.
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
src/apps/shared/         code shared by apps (bearer auth, MCP HTTP handler, trace ids)
src/apps/tenant-sample-server/  a tenant's own MCP server (third party, API key)
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
