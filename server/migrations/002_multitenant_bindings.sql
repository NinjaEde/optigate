-- Migration 002: multi-tenant credential bindings + shared servers.
-- Executed automatically on server boot (also inlined in ensureSchema).

-- Shared servers: visible to all tenants, per-tenant credential bindings.
ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;

-- Per-tenant credential overrides for a server record.
-- tenant_id NULL = default binding (fallback for tenants without one).
CREATE TABLE IF NOT EXISTS server_credential_bindings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id   UUID NOT NULL REFERENCES mcp_servers(id),
    tenant_id   TEXT,
    auth_enc    JSONB NOT NULL,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sc_bindings_server_tenant
    ON server_credential_bindings (server_id, coalesce(tenant_id, ''));
