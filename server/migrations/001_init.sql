-- Initial schema for OptiGate (MCP gateway & registry).
-- Executed automatically on server boot when DATABASE_URL is configured.

CREATE TABLE IF NOT EXISTS mcp_servers (
    id          UUID PRIMARY KEY,
    tenant_id   TEXT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    scope       TEXT NOT NULL CHECK (scope IN ('global', 'tenant', 'private')),
    owner_id    TEXT,
    transport   TEXT NOT NULL CHECK (transport IN ('stdio', 'streamable_http', 'sse')),
    connection  JSONB NOT NULL DEFAULT '{}',
    status      TEXT NOT NULL DEFAULT 'pending_approval',
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_name_tenant
    ON mcp_servers (coalesce(tenant_id, ''), name)
WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
    id         UUID PRIMARY KEY,
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id   TEXT NOT NULL,
    tenant_id  TEXT,
    action     TEXT NOT NULL,
    subject_id TEXT,
    detail     JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events (at DESC);
