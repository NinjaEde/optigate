# OptiGate

**Your optimized MCP gateway.** One endpoint for all your MCP servers — with
token-sparing tool retrieval built in.

OptiGate is an MCP server registry and gateway. It manages your MCP servers
(registration, health, approval workflow, audit) and exposes them to any MCP
client through a single Streamable HTTP endpoint. Instead of loading hundreds
of tool schemas into the LLM context, clients query two meta-tools and
retrieve only the tools they actually need.

```
MCP Client ──▶ POST /mcp ──▶ OptiGate ──▶ managed MCP servers (HTTP/SSE/stdio)
                search_tools + execute_tool only
```

## Why

- **Token explosion** — dozens of MCP servers with hundreds of tools don't fit
  into a context window. OptiGate's retrieval returns the top-k relevant tools
  per query (~200–800 tokens regardless of registry size).
- **No governance** — who may register which server? Which tool was called
  when, by whom, with what arguments? OptiGate ships roles, approval workflow,
  and a full audit log.
- **N+1 client configuration** — without a gateway, every client needs every
  server registered individually. With OptiGate, one entry covers them all.

## Features

| | |
|---|---|
| **Token-sparing retrieval** | `search_tools(query, k)` returns the k most relevant tool cards across all managed servers |
| **MCP facade** | The registry itself is an MCP server: `search_tools` + `execute_tool` over stateless JSON-RPC at `/mcp` |
| **Multi-transport** | Manages `streamable_http`, `sse`, and `stdio` servers |
| **Governance** | Scopes (`global` / `tenant` / `private`), approval workflow, disable/enable, full audit trail |
| **Auth** | Keycloak JWT (RS256/JWKS) in production, dev mode for local testing |
| **Self-updating index** | Auto-connects healthy servers on boot (3 retries each), keeps the tool index fresh on a 60 s loop |
| **Admin UI** | Server cards with status badges, custom key/value headers, live tool search view, audit feed — DE/EN/FR |

## Quick Start (Docker Compose)

The fastest way to run OptiGate is the bundled Compose stack — no local Node
or Postgres required:

```bash
# Development stack: Postgres + API (hot reload via tsx watch) + Web UI (Vite HMR)
docker compose -f docker-compose.dev.yml up

# UI   → http://localhost:3000
# API  → http://localhost:8100/health
# MCP  → http://localhost:8100/mcp
```

For production:

```bash
KEYCLOAK_URL=... KEYCLOAK_REALM=... POSTGRES_PASSWORD=... \
  docker compose up --build -d

# UI  : http://localhost:8080  (nginx, /api proxied to the server)
# API : http://localhost:8100  (Keycloak JWT required)
```

Data lives in the `pgdata` volume; the schema is created idempotently on boot.

### Run without Docker

Both services are plain Node projects:

```bash
cd server && npm i && AUTH_MODE=dev npm run dev    # API on :8100
cd web    && npm i && npm run dev                  # UI on :5173 (proxies /api)
```

Without `DATABASE_URL` the server runs on an **in-memory repository** — handy
for trying it out, but data is lost on restart.

## Connecting MCP clients

Register OptiGate once in any MCP client:

```json
{
  "mcpServers": {
    "optigate": {
      "type": "http",
      "url": "http://localhost:8100/mcp",
      "headers": { "x-dev-user": "alice" }
    }
  }
}
```

That's it — `search_tools` and `execute_tool` now give the client access to
every visible registry server.

## How the token saving works

1. `search_tools("chart", k=5)` → lexically scored tool cards (name,
   description, input schema) across all indexed servers.
2. `execute_tool(server_id, tool_name, args)` → routed through the connection
   pool; only `healthy` servers, scope-checked for the caller.

Context cost stays constant no matter whether you manage 20 or 2,000 tools.
The web UI has a **Tool Search** view that runs the exact same retrieval path,
so you can inspect what agents would see.

## Multi-tenancy & user separation

Every request carries an authenticated identity (`AuthContext`) consisting of
`userId`, `role`, and `tenantId`. This identity drives three policy checks:

**1. Scope visibility (`canView`) — what may this user see?**

| Server scope | Who sees it |
|---|---|
| `global` | everyone |
| `tenant` | users whose `tenantId` matches the server's tenant |
| `private` | only the user who registered it (`ownerId === userId`) |

All list/search/execute endpoints filter through this rule, so tenants cannot
see each other's servers and private servers stay invisible to everyone else.

**2. Registration rights (`canRegister`) — who may register what?**

`global` scope requires `superadmin`; `tenant` and `private` require at least
`admin`. The registering user's tenant/user id is stored on the server record
and later used for visibility and ownership checks.

**3. Approvals (`canApprove`) — supply-chain gate**

New servers start as `pending_approval` when `APPROVAL_REQUIRED=true`; only
`superadmin`s can approve them into `healthy` state (or re-enable disabled
ones). Unapproved servers never appear in any index or search result.

In production the identity comes from a Keycloak JWT: `userId` from the
`sub` claim, roles from `realm_access`/`resource_access`, and `tenantId` from
the first `organization` claim.

## Dev authentication (`AUTH_MODE=dev`) and its headers

Dev mode skips token verification and derives the identity from optional
request headers — so you can test multi-user behavior locally without an IdP:

| Header | Default | Meaning |
|---|---|---|
| `x-dev-user` | `dev-user` | Sets the `userId` (owner of `private` servers, audit actor) |
| `x-dev-role` | `superadmin` | One of `superadmin` / `admin` / `user` — controls registration and approval rights |
| `x-dev-tenant` | `dev-tenant` | Sets the `tenantId` — controls visibility of `tenant`-scoped servers |

Example — simulate a plain user of another tenant:

```bash
curl -H "x-dev-user: bob" -H "x-dev-role: user" -H "x-dev-tenant: other" \
  http://localhost:8100/api/servers
```

Without these headers every dev request acts as the default superadmin in
`dev-tenant`.

> **Warning:** dev headers grant full identity control by design. Never run
> `AUTH_MODE=dev` on a network-exposed instance; use Keycloak mode instead.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `keycloak` | `dev` = header-based identity, no token required |
| `DATABASE_URL` | – | Postgres connection; unset = in-memory repository |
| `APPROVAL_REQUIRED` | `true` | New servers start as `pending_approval` |
| `PORT` | `8100` | API listen port |
| `SECRET_ENCRYPTION_KEY` | – | AES-256-GCM key for direct secret entry |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` | – | JWKS source for token verification |
| `KEYCLOAK_AUDIENCE` | realm value | Expected JWT audience |

## Development

```bash
cd server && npm test          # vitest (44 tests)
cd server && npm run build     # tsc → dist/
cd web    && npm run build     # vite build
```

## Stack

Node.js 24 · Fastify · TypeScript · official MCP SDK · Postgres 17 ·
React 18 · Vite · Tailwind CSS v4

## License

MIT
