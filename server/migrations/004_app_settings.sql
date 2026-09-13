-- Migration 004: runtime-tunable app settings (DB overrides env/default).
-- Executed automatically on server boot (also inlined in ensureSchema).

-- Global key/value settings. Only whitelisted keys (see
-- SettingsService.SETTING_DEFS) are readable/writable through the API.
CREATE TABLE IF NOT EXISTS app_settings (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
