import { buildApp } from './app.js';
import { InMemoryServerRepository } from './infra/repositories/memoryServerRepository.js';
import { InMemoryAuditLog } from './infra/repositories/memoryAuditLog.js';
import {
  PostgresServerRepository,
  PostgresAuditLog,
} from './infra/repositories/postgresRepository.js';
import { McpClientPool } from './infra/mcp/clientPool.js';
import { createSdkTransport } from './infra/mcp/sdkTransport.js';
import { verifyKeycloakToken } from './infra/auth/keycloak.js';

const PORT = Number(process.env.PORT ?? 8100);
const APPROVAL_REQUIRED = process.env.APPROVAL_REQUIRED === 'true';
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * Production auth: Keycloak JWT via Bearer header.
 * Falls back to a dev stub only when AUTH_MODE=dev.
 */
async function resolveAuth(request: { headers: Record<string, unknown> }) {
  const authHeader = String(request.headers.authorization ?? '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (process.env.AUTH_MODE !== 'dev' && token) {
    const user = await verifyKeycloakToken(token);
    if (user) {
      return user;
    }
  }

  if (process.env.AUTH_MODE === 'dev') {
    // deterministic dev identity so local flows work without Keycloak
    return {
      userId: 'dev-user',
      role: 'superadmin' as const,
      tenantId: 'dev-tenant',
    };
  }

  throw new Error('Unauthorized');
}

async function createPostgresStores(databaseUrl: string) {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const serverRepo = new PostgresServerRepository(pool);
  const auditLog = new PostgresAuditLog(pool);
  await serverRepo.ensureSchema();
  return { pool, serverRepo, auditLog };
}

async function main() {
  let repo;
  let audit;

  if (DATABASE_URL) {
    console.log('Using Postgres persistence');
    const { pool, serverRepo, auditLog } =
      await createPostgresStores(DATABASE_URL);
    repo = serverRepo;
    audit = auditLog;
    void pool; // pooled connections live for the process lifetime
  } else {
    console.log('Using in-memory persistence (set DATABASE_URL for Postgres)');
    repo = new InMemoryServerRepository();
    audit = new InMemoryAuditLog();
  }

  const app = await buildApp({
    auth: { resolveAuth },
    registry: { repo, audit },
    pool: new McpClientPool(createSdkTransport),
    approvalRequired: APPROVAL_REQUIRED,
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
