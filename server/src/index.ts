import { buildApp } from './app.js';
import { InMemoryServerRepository } from './infra/repositories/memoryServerRepository.js';
import { InMemoryAuditLog } from './infra/repositories/memoryAuditLog.js';
import {
  PostgresApiKeyStore,
  PostgresServerRepository,
  PostgresAuditLog,
  PostgresCredentialResolver,
  PostgresSettingsStore,
  PostgresUserStore,
} from './infra/repositories/postgresRepository.js';
import { McpClientPool } from './infra/mcp/clientPool.js';
import { createSdkTransport } from './infra/mcp/sdkTransport.js';
import { verifyKeycloakToken } from './infra/auth/keycloak.js';
import {
  hashPassword,
  normalizeUsername,
  parseTtl,
  secretFingerprint,
  verifyLocalToken,
} from './infra/auth/local.js';
import { InMemoryCredentialResolver } from './infra/mcp/credentialResolver.js';
import { ApiKeyService } from './services/apiKeyService.js';
import { InMemoryApiKeyStore } from './infra/repositories/memoryApiKeyStore.js';
import { SettingsService } from './services/settingsService.js';
import { InMemorySettingsStore } from './infra/repositories/memorySettingsStore.js';
import { LOCAL_MIN_PASSWORD_LENGTH, UserService } from './services/userService.js';
import { InMemoryUserStore } from './infra/repositories/memoryUserStore.js';
import { sanitizeTenantId } from './infra/auth/keycloak.js';

const PORT = Number(process.env.PORT ?? 8100);
const DATABASE_URL = process.env.DATABASE_URL;
const CORS_ORIGIN = process.env.CORS_ORIGIN;

export type AuthMode = 'dev' | 'local' | 'keycloak';

export function resolveAuthMode(raw: string | undefined): AuthMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'dev' || v === 'local' || v === 'keycloak') {
    return v;
  }
  return 'keycloak';
}

const AUTH_MODE: AuthMode = resolveAuthMode(process.env.AUTH_MODE);
const LOCAL_JWT_SECRET = process.env.LOCAL_JWT_SECRET ?? '';
const LOCAL_JWT_TTL_MS = parseTtl(process.env.LOCAL_JWT_TTL, 12 * 3_600_000);

/**
 * Auth chain (API-key first, then per-mode identity):
 *   dev      → header stub (x-dev-*) — local testing without any token
 *   local    → self-signed HS256 JWT (POST /auth/login) — no Keycloak needed
 *   keycloak → RS256/JWKS bearer verification (production default)
 */
async function resolveAuth(
  request: { headers: Record<string, unknown> },
  lookupLocalUser: (userId: string) => Promise<{ isActive: boolean } | null>,
) {
  const authHeader = String(request.headers.authorization ?? '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (AUTH_MODE === 'local' && token) {
    const claims = verifyLocalToken(token, LOCAL_JWT_SECRET);
    if (claims) {
      // Role/tenant changes and deactivations apply on the next request.
      const user = await lookupLocalUser(claims.userId);
      if (user?.isActive) {
        return claims;
      }
    }
  }

  if (AUTH_MODE === 'keycloak' && token) {
    const user = await verifyKeycloakToken(token, (msg) =>
      console.warn(`[auth] ${msg}`),
    );
    if (user) {
      return user;
    }
  }

  if (AUTH_MODE === 'dev') {
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
  if (AUTH_MODE === 'local' && LOCAL_JWT_SECRET.length < 32) {
    console.error(
      'Fatal: AUTH_MODE=local requires LOCAL_JWT_SECRET with at least 32 characters.',
    );
    process.exit(1);
  }

  let repo;
  let audit;
  let healthCheck: (() => Promise<void>) | undefined;
  let credentials;
  let apiKeyStore;
  let settingsStore;
  let userStore;

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
    settingsStore = new PostgresSettingsStore(pool);
    userStore = new PostgresUserStore(pool);
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
    settingsStore = new InMemorySettingsStore();
    userStore = new InMemoryUserStore();
  }

  const apiKeys = new ApiKeyService(apiKeyStore, audit);
  const settings = new SettingsService(settingsStore, audit);
  const users = new UserService(userStore, audit);
  await settings.refresh().catch((err) => {
    console.warn(`[settings] preload failed, using env/defaults: ${(err as Error).message}`);
  });

  if (AUTH_MODE === 'local') {
    const existing = await users.count().catch(() => -1);
    const bootUser = normalizeUsername(process.env.LOCAL_BOOTSTRAP_ADMIN_USER ?? '');
    const bootPass = process.env.LOCAL_BOOTSTRAP_ADMIN_PASSWORD ?? '';
    if (existing === 0 && bootUser && bootPass) {
      if (bootPass.length < LOCAL_MIN_PASSWORD_LENGTH) {
        console.error(
          `Fatal: LOCAL_BOOTSTRAP_ADMIN_PASSWORD must be at least ${LOCAL_MIN_PASSWORD_LENGTH} characters.`,
        );
        process.exit(1);
      }
      const now = new Date().toISOString();
      await userStore.insert({
        id: crypto.randomUUID(),
        username: bootUser,
        passwordHash: await hashPassword(bootPass),
        role: 'superadmin',
        tenantId: sanitizeTenantId(process.env.LOCAL_BOOTSTRAP_ADMIN_TENANT ?? null),
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`[auth] bootstrapped local superadmin "${bootUser}"`);
    } else if (existing === 0) {
      console.warn(
        '[auth] local mode with zero users: set LOCAL_BOOTSTRAP_ADMIN_USER/_PASSWORD to create the first superadmin, then manage the rest via POST /api/users.',
      );
    }
    console.log(
      `[auth] local mode: HS256 sessions (secret ${secretFingerprint(LOCAL_JWT_SECRET)}), ttl ${LOCAL_JWT_TTL_MS}ms`,
    );
  }

  const app = await buildApp({
    auth: {
      /**
       * Gateway API keys (x-api-key header) resolve first and yield a
       * gateway-only identity; everything else falls back to the
       * Keycloak/dev/local chain. A presented-but-invalid key fails closed.
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
        return resolveAuth(request, async (userId) =>
          users.findById(userId),
        );
      },
    },
    apiKeys,
    settings,
    // Local user management is only wired in local mode — in dev/keycloak
    // mode /auth/login and /api/users answer 404 (disabled) and behavior
    // is exactly as before.
    users: AUTH_MODE === 'local' ? users : undefined,
    authMode: AUTH_MODE,
    local:
      AUTH_MODE === 'local'
        ? { jwtSecret: LOCAL_JWT_SECRET, ttlMs: LOCAL_JWT_TTL_MS }
        : undefined,
    registry: { repo, audit },
    pool: new McpClientPool(
      async (server, authOverride) =>
        createSdkTransport(server, authOverride, {
          allowedHosts: settings.getCached<string>('ssrf.allowedHosts'),
          allowPrivateRanges: settings.getCached<boolean>('ssrf.allowPrivateRanges'),
        }),
      {
        maxConnectionsPerServer: () =>
          settings.getCached<number>('pool.maxConnsPerServer'),
        credentialResolver: credentials,
      },
    ),
    credentials,
    approvalRequired: () => settings.getCached<boolean>('registry.approvalRequired'),
    healthCheck,
    corsOrigin: CORS_ORIGIN,
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
