import { Pool, type PoolClient } from 'pg';

import type { AuditEvent, MCPServer } from '../../domain/types.js';
import type { ServerRepository } from '../../services/registryService.js';
import type { AuditSink } from '../../services/registryService.js';

/**
 * Postgres-backed repository. Activated automatically when DATABASE_URL
 * is set; schema is ensured on first use via migrations/001_init.sql.
 */

interface ServerRow {
  id: string;
  tenant_id: string | null;
  name: string;
  description: string;
  scope: MCPServer['scope'];
  owner_id: string | null;
  shared: boolean;
  transport: MCPServer['transport'];
  connection: MCPServer['connection'];
  status: MCPServer['status'];
  created_by: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

function rowToServer(row: ServerRow): MCPServer {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    shared: row.shared,
    ownerId: row.owner_id,
    transport: row.transport,
    connection: row.connection,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
  };
}

export class PostgresServerRepository implements ServerRepository {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(migrationSql());
  }

  static async create(databaseUrl: string): Promise<PostgresServerRepository> {
    const pool = new Pool({ connectionString: databaseUrl });
    const client = await pool.connect();
    try {
      await client.query(migrationSql());
    } finally {
      client.release();
    }
    return new PostgresServerRepository(pool);
  }

  async insert(server: MCPServer): Promise<void> {
    await this.pool.query(
      `INSERT INTO mcp_servers
       (id, tenant_id, name, description, scope, owner_id, shared, transport,
        connection, status, created_by, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        server.id,
        server.tenantId,
        server.name,
        server.description,
        server.scope,
        server.ownerId,
        server.shared,
        server.transport,
        JSON.stringify(server.connection),
        server.status,
        server.createdBy,
        server.createdAt,
        server.updatedAt,
        server.deletedAt,
      ],
    );
  }

  async findById(id: string): Promise<MCPServer | null> {
    const res = await this.pool.query<ServerRow>(
      `SELECT * FROM mcp_servers WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    return res.rows[0] ? rowToServer(res.rows[0]) : null;
  }

  async findByNameInTenant(
    name: string,
    tenantId: string | null,
  ): Promise<MCPServer | null> {
    const res = await this.pool.query<ServerRow>(
      `SELECT * FROM mcp_servers
       WHERE name = $1 AND coalesce(tenant_id, '') = coalesce($2, '')
         AND deleted_at IS NULL`,
      [name, tenantId],
    );
    return res.rows[0] ? rowToServer(res.rows[0]) : null;
  }

  async allActive(): Promise<MCPServer[]> {
    const res = await this.pool.query<ServerRow>(
      `SELECT * FROM mcp_servers WHERE deleted_at IS NULL ORDER BY created_at DESC`,
    );
    return res.rows.map(rowToServer);
  }

  async save(server: MCPServer): Promise<void> {
    await this.pool.query(
      `UPDATE mcp_servers SET
         tenant_id = $2, name = $3, description = $4, scope = $5,
         owner_id = $6, shared = $7, transport = $8, connection = $9,
         status = $10, created_by = $11, created_at = $12, updated_at = $13,
         deleted_at = $14
       WHERE id = $1`,
      [
        server.id,
        server.tenantId,
        server.name,
        server.description,
        server.scope,
        server.ownerId,
        server.shared,
        server.transport,
        JSON.stringify(server.connection),
        server.status,
        server.createdBy,
        server.createdAt,
        server.updatedAt,
        server.deletedAt,
      ],
    );
  }
}

function migrationSql(): string {
  // inlined copy of migrations/001_init.sql so the module stays self-contained
  return `
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

    ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;

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
  `;
}

export class PostgresAuditLog implements AuditSink {
  constructor(private readonly pool: Pool) {}

  async record(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id, at, actor_id, tenant_id, action, subject_id, detail)
       VALUES ($1, now(), $2, $3, $4, $5, $6)`,
      [
        crypto.randomUUID(),
        event.actorId,
        event.tenantId,
        event.action,
        event.subjectId,
        JSON.stringify(event.detail),
      ],
    );
  }

  async recent(limit = 100): Promise<AuditEvent[]> {
    const res = await this.pool.query<{
      id: string;
      at: Date;
      actor_id: string;
      tenant_id: string | null;
      action: string;
      subject_id: string | null;
      detail: Record<string, unknown>;
    }>(
      `SELECT * FROM audit_events ORDER BY at DESC LIMIT $1`,
      [limit],
    );

    return res.rows.map((row): AuditEvent => ({
      id: row.id,
      at: row.at.toISOString(),
      actorId: row.actor_id,
      tenantId: row.tenant_id,
      action: row.action as AuditEvent['action'],
      subjectId: row.subject_id,
      detail: row.detail,
    }));
  }
}

export type { PoolClient };
