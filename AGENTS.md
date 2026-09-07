# OptiGate — Agent Instructions

## Project Structure

- `server/` — Fastify API (TypeScript, ESM, Node 24)
- `web/` — React 18 + Vite + Tailwind CSS v4
- `docker-compose.dev.yml` — Full dev stack (Postgres + API + Web UI)

## Dev Commands

```bash
# Start dev stack (Docker)
docker compose -f docker-compose.dev.yml up

# Server (without Docker)
cd server && npm i && AUTH_MODE=dev npm run dev

# Web UI (without Docker)
cd web && npm i && npm run dev
```

## Tests

```bash
# Server: vitest with InMemory repositories (no DB required)
cd server && npm test

# Single test file
cd server && npx vitest run tests/http/api.test.ts
```

Web tests exist but are minimal (`web/tests/setup.ts` only).

## Lint / Typecheck

```bash
cd server && npm run lint && npm run typecheck
cd web && npm run lint && npm run typecheck
```

**ESLint rule to remember:** `@typescript-eslint/consistent-type-imports: error` — always use `import type { Foo }` for type-only imports.

## Auth

- Production: Keycloak JWT (RS256)
- Dev mode: Set `AUTH_MODE=dev`, control identity via headers:
  - `x-dev-user` (default: `dev-user`)
  - `x-dev-role` (`superadmin` | `admin` | `user`)
  - `x-dev-tenant` (default: `dev-tenant`)

## Key Architecture Facts

- Server entrypoint: `server/src/index.ts` → `server/src/app.ts`
- Domain types: `server/src/domain/types.ts` (`MCPServer`, `AuthContext`, `ToolMeta`)
- MCP gateway: `/mcp` endpoint exposes `search_tools` + `execute_tool`
- Tool index reconciler auto-connects healthy servers on boot (3 retries each, 60s refresh loop)
- Secrets are AES-256-GCM encrypted at rest (`secretPlaintext` → `secretEnc`)
- Scopes: `global` (superadmin only), `tenant` (admin+), `private` (user+)

## Common Pitfalls

- Tests use `x-test-user` header (not `x-dev-user`) for auth stub
- Postgres tests require `DATABASE_URL` set, otherwise skip
- `tsc-alias` runs after `tsc` in server build (`npm run build`)
- Docker volumes for `node_modules` keep container deps isolated from host
