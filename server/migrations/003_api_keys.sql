-- Migration 003: gateway API keys (gateway-only access, hash at rest).
-- Executed automatically on server boot (also inlined in ensureSchema).

-- Gateway API keys: only the SHA-256 hash is stored, the plaintext
-- secret is shown exactly once at creation time.
-- tenant_id NULL = platform-wide key (superadmin-created).
CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY,
    name        TEXT NOT NULL,
    key_prefix  TEXT NOT NULL,
    key_hash    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'user')),
    tenant_id   TEXT,
    expires_at  TIMESTAMPTZ,
    revoked_at  TIMESTAMPTZ,
    created_by  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix);
