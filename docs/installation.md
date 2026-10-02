# Installation

The fastest way to run OptiGate is the bundled Docker Compose stack — no local Node or Postgres required.

```bash
# Copy the example env and adjust
cp .env.example .env

# Development stack: Postgres + API (hot reload) + Web UI (Vite HMR)
docker compose -f docker-compose.dev.yml up

# UI   → http://localhost:3030
# API  → http://localhost:8100/health
# MCP  → http://localhost:8100/mcp
```

For production:

```bash
# Set these in your environment or .env:
#   AUTH_MODE=keycloak   KEYCLOAK_URL=...   KEYCLOAK_REALM=...
#   SECRET_ENCRYPTION_KEY=...   POSTGRES_PASSWORD=...
docker compose up --build -d

# UI  : http://localhost:8080  (nginx, /api proxied to the server)
# API : http://localhost:8100  (Keycloak JWT required)
```

Data lives in the `pgdata` volume; the schema is created idempotently on boot.

## Run without Docker

Both services are plain Node projects:

```bash
cd server && npm i && AUTH_MODE=dev npm run dev    # API on :8100
cd web    && npm i && npm run dev                  # UI on :5173 (proxies /api)
```

Without `DATABASE_URL` the server runs on an **in-memory repository** — handy for trying it out, but data is lost on restart.

## First steps

1. Open the UI and register an MCP server (HTTP/SSE) or stdio command.
2. Approve it if `APPROVAL_REQUIRED=true` (supply-chain gate).
3. Open the **Tool Search** view and try a query — that's exactly what agents see.
4. Register OptiGate once in your MCP client (see [Connecting clients](./clients.md)).

Next: [configuration](./configuration.md) · [decision-model reranking](./decision-model.md)
