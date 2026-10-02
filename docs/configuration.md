# Configuration

All settings follow one precedence chain and are live-tunable by admins in the UI's **Settings** view (`GET/PUT/DELETE /api/settings`):

```
database value > environment variable > built-in default
```

Security-sensitive keys (`ssrf.*`, `registry.approvalRequired`) require superadmin; every change is audited as `setting.changed`.

## Core

| Variable | Default | Purpose |
|---|---|---|
| `AUTH_MODE` | `keycloak` | `dev` = header-based identity · `local` = username/password login · `keycloak` = RS256/JWKS bearer verification |
| `DATABASE_URL` | – | Postgres connection; unset = in-memory repository |
| `APPROVAL_REQUIRED` | `true` | New servers start as `pending_approval` |
| `SECRET_ENCRYPTION_KEY` | – | AES-256-GCM key for secrets at rest (min 32 chars) |

## Retrieval & gateway

| Variable | Default | Purpose |
|---|---|---|
| `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` | `5` / `20` | Tool retrieval top-k bounds |
| `GATEWAY_DISPATCH_TIMEOUT_MS` | `30000` | Per-request timeout of the `/mcp` gateway |
| `RECONCILE_INTERVAL_MS` / `RECONCILE_RETRY_MS` / `RECONCILE_MAX_STALE` | `60000` / `5000` / `10` | Tool index refresh tuning |
| `RATE_LIMIT_MAX` | `200` | Global rate limit (requests/minute/IP) |

## Decision model

| Variable | Default | Purpose |
|---|---|---|
| `DECISION_MODEL_ENABLED` | `false` | Opt-in switch for `mode="decision"` |
| `DECISION_MODEL_PROVIDER` | `openai-compatible` | `jev` or `openai-compatible` |
| `DECISION_MODEL_BASE_URL` | – | e.g. `https://openrouter.ai/api/v1` |
| `DECISION_MODEL_MODEL` | – | e.g. `typesafe/jev-1.13` |
| `DECISION_MODEL_API_KEY` | – | Prefer the Settings view (encrypted at rest) |
| `DECISION_MODEL_TIMEOUT_MS` / `DECISION_MODEL_CANDIDATE_POOL` | `3000` / `20` | Call timeout and candidate pool size |
| `DECISION_MODEL_FORCE` | `false` | Force reranking for every search once configured |

See [decision-model reranking](./decision-model.md) for the full guide.

## Auth

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_JWT_SECRET` | – | Required in local mode (min 32 chars) |
| `LOCAL_JWT_TTL` | `12h` | Local session lifetime |
| `LOCAL_BOOTSTRAP_ADMIN_USER` / `LOCAL_BOOTSTRAP_ADMIN_PASSWORD` | – | First superadmin, created once on empty user table |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_AUDIENCE` | – | Keycloak issuer, realm, expected audience |
| `CORS_ORIGIN` | all origins | Allowed CORS origins |
| `MAX_CONNS_PER_SERVER` | `20` | Max simultaneous upstream connections per server |
| `SSRF_ALLOWED_HOSTS` | – | Allowed hosts/globs for outgoing MCP connections |
| `SSRF_ALLOW_PRIVATE_RANGES` | `false` | Homelab escape hatch (loopback/private ranges) |

The complete list with descriptions lives in `.env.example` in the repo.
