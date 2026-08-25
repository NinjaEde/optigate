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
| 🔍 **Token-sparing retrieval** | `search_tools(query, k)` returns the k most relevant tool cards across all managed servers |
| 🚪 **MCP facade** | The registry itself is an MCP server: `search_tools` + `execute_tool` over stateless JSON-RPC at `/mcp` |
| 🔌 **Multi-transport** | Manages `streamable_http`, `sse`, and `stdio` servers |
| 🛡️ **Governance** | Scopes (`global` / `tenant` / `private`), approval workflow, disable/enable, full audit trail |
| 🔐 **Auth** | Keycloak JWT (RS256/JWKS) in production, dev mode for local hacking |
| 🔄 **Self-updating index** | Auto-connects healthy servers on boot (3 retries each), keeps the tool index fresh on a 60 s loop |
| 🖥️ **Admin UI** | Server cards with status badges, custom key/value headers, live tool search view, audit feed — DE/EN/FR |

## Quick Start

```bash
# Dev stack: Postgres + API (tsx watch) + Web UI (Vite HMR)
docker compose -f docker-compose.dev.yml up

# UI   → http://localhost:3000
# API  → http://localhost:8100/health
# MCP  → http://localhost:8100/mcp
```

Or run locally:

```bash
cd server && npm i && AUTH_MODE=dev npm run dev    # :8100
cd web    && npm i && npm run dev                  # :5173 (proxies /api)
```

### Use it from any MCP client

```json
{
  "mcpServers": {
    "optigate": {
      "type": "http",
      "url": "http://localhost:8100/mcp",
      "headers": { "x-dev-user": "edgar" }
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

## Production

```bash
KEYCLOAK_URL=... KEYCLOAK_REALM=... POSTGRES_PASSWORD=... \
  docker compose up --build -d
# UI  : http://localhost:8080  (nginx, /api proxied)
# API : http://localhost:8100  (Keycloak JWT required)
```

Data lives in the `pgdata` volume; the schema is created idempotently on boot.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `keycloak` | `dev` = fixed dev superadmin, no token |
| `DATABASE_URL` | – | Postgres connection; unset = in-memory repository |
| `APPROVAL_REQUIRED` | `true` | New servers start as `pending_approval` |
| `SECRET_ENCRYPTION_KEY` | – | AES-256-GCM key for direct secret entry |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` | – | JWKS source for token verification |

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
