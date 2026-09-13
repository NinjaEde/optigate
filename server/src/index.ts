import { buildApp } from './app.js';
import { InMemoryServerRepository } from './infra/repositories/memoryServerRepository.js';
import { InMemoryAuditLog } from './infra/repositories/memoryAuditLog.js';
import {
  PostgresApiKeyStore,
  PostgresServerRepository,
  PostgresAuditLog,
  PostgresCredentialResolver,
} from './infra/repositories/postgresRepository.js';
import { McpClientPool } from './infra/mcp/clientPool.js';
import { createSdkTransport } from './infra/mcp/sdkTransport.js';
import { verifyKeycloakToken } from './infra/auth/keycloak.js';
import { InMemoryCredentialResolver } from './infra/mcp/credentialResolver.js';
import { ApiKeyService } from './services/apiKeyService.js';
import { InMemoryApiKeyStore } from './infra/repositories/memoryApiKeyStore.js';

const PORT = Number(process.env.PORT ?? 8100);
const APPROVAL_REQUIRED = process.env.APPROVAL_REQUIRED === 'true';
const DATABASE_URL = process.env.DATABASE_URL;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

/**
 * Production auth: Keycloak JWT via Bearer header.
 * Falls back to a dev stub only when AUTH_MODE=dev.
 */
async function resolveAuth(request: { headers: Record<string, unknown> }) {
  const authHeader = String(request.headers.authorization ?? '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (process.env.AUTH_MODE !== 'dev' && token) {
    const user = await verifyKeycloakToken(token, (msg) =>
      console.warn(`[auth] ${msg}`),
    );
    if (user) {
      return user;
    }
  }

  if (process.env.AUTH_MODE === 'dev') {
    // Deterministic dev identity so local flows work without Keycloak.
    // Optional headers allow simulating different users/tenants/roles
    // (useful for testing scope visibility without a real IdP).
    const DEV_ROLES = ['superadmin', 'admin', 'user'] as const;
    type DevRole = (typeof DEV_ROLES)[number];

    const roleHeader = String(request.headers['x-dev-role'] ?? '');
    const role: DevRole = DEV_ROLES.includes(roleHeader as DevRole)
      ? (roleHeader as DevRole)
      : 'superadmin';

    return {
      userId: String(request.headers['x-dev-user'] ?? 'dev-user'),
      role,
      tenantId: String(request.headers['x-dev-tenant'] ?? 'dev-tenant'),
    };
  }

  throw new Error('Unauthorized');
}

async function main() {
  let repo;
  let audit;
  let healthCheck: (() => Promise<void>) | undefined;
  let credentials;
  let apiKeyStore;

  if (DATABASE_URL) {
    console.log('Using Postgres persistence');
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: DATABASE_URL });
    const serverRepo = new PostgresServerRepository(pool);
    const auditLog = new PostgresAuditLog(pool);
    await serverRepo.ensureSchema();
    repo = serverRepo;
    audit = auditLog;
    credentials = new PostgresCredentialResolver(pool);
    apiKeyStore = new PostgresApiKeyStore(pool);
    healthCheck = async () => {
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    };
    void pool;
  } else {
    console.log('Using in-memory persistence (set DATABASE_URL for Postgres)');
    repo = new InMemoryServerRepository();
    audit = new InMemoryAuditLog();
    credentials = new InMemoryCredentialResolver();
    apiKeyStore = new InMemoryApiKeyStore();
  }

  const apiKeys = new ApiKeyService(apiKeyStore, audit);

  const app = await buildApp({
    auth: {
      /**
       * Gateway API keys (x-api-key header) resolve first and yield a
       * gateway-only identity; everything else falls back to the
       * Keycloak/dev chain. A presented-but-invalid key fails closed.
       */
      resolveAuth: async (request) => {
        const presented = String(request.headers['x-api-key'] ?? '');
        if (presented) {
          const identity = await apiKeys.verifyKey(presented);
          if (!identity) {
            throw new Error('Unauthorized');
          }
          return {
            userId: identity.userId,
            role: identity.role,
            tenantId: identity.tenantId,
            viaApiKey: true as const,
          };
        }
        return resolveAuth(request);
      },
    },
    apiKeys,
    registry: { repo, audit },
    pool: new McpClientPool(createSdkTransport, {
      maxConnectionsPerServer: Number(process.env.MAX_CONNS_PER_SERVER ?? 20),
      credentialResolver: credentials,
    }),
    credentials,
    approvalRequired: APPROVAL_REQUIRED,
    healthCheck,
    corsOrigin: CORS_ORIGIN,
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
