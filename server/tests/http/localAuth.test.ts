import { describe, it, expect, beforeEach } from 'vitest';

import { buildApp } from '../../src/app';
import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { InMemoryAuditLog } from '../../src/infra/repositories/memoryAuditLog';
import { InMemoryApiKeyStore } from '../../src/infra/repositories/memoryApiKeyStore';
import { InMemorySettingsStore } from '../../src/infra/repositories/memorySettingsStore';
import { InMemoryUserStore } from '../../src/infra/repositories/memoryUserStore';
import { SettingsService } from '../../src/services/settingsService';
import { ApiKeyService } from '../../src/services/apiKeyService';
import { UserService } from '../../src/services/userService';
import { McpClientPool } from '../../src/infra/mcp/clientPool';
import { CredentialResolver } from '../../src/infra/mcp/credentialResolver';

const SECRET = 'local-test-secret-with-32-chars-min!!';

async function makeLocalApp() {
  const audit = new InMemoryAuditLog();
  const userStore = new InMemoryUserStore();
  const users = new UserService(userStore, audit);
  const bootstrapAuth = { userId: 'bootstrap', role: 'superadmin' as const, tenantId: null };
  const alice = await users.createUser(bootstrapAuth, {
    username: 'alice',
    password: 'supersecret-password',
    role: 'admin',
    tenantId: 't1',
  });
  const bob = await users.createUser(bootstrapAuth, {
    username: 'bob',
    password: 'another-secret-pw',
    role: 'user',
    tenantId: 't1',
  });

  const app = await buildApp({
    auth: {
      resolveAuth: async (request) => {
        const header = String(request.headers.authorization ?? '');
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) {
          throw new Error('Unauthorized');
        }
        const { verifyLocalToken } = await import('../../src/infra/auth/local');
        const claims = verifyLocalToken(token, SECRET);
        if (!claims) {
          throw new Error('Unauthorized');
        }
        const found = await users.findById(claims.userId);
        if (!found || !found.isActive) {
          throw new Error('Unauthorized');
        }
        return claims;
      },
    },
    registry: { repo: new InMemoryServerRepository(), audit },
    pool: new McpClientPool(async () => {
      throw new Error('no transports in test');
    }),
    credentials: new CredentialResolver(),
    apiKeys: new ApiKeyService(new InMemoryApiKeyStore(), audit),
    settings: new SettingsService(new InMemorySettingsStore(), audit),
    users,
    authMode: 'local',
    local: { jwtSecret: SECRET, ttlMs: 3_600_000 },
    approvalRequired: false,
  });
  await app.ready();
  return { app, users, alice, bob };
}

describe('local auth HTTP', () => {
  let app: Awaited<ReturnType<typeof makeLocalApp>>['app'];
  let users: Awaited<ReturnType<typeof makeLocalApp>>['users'];

  beforeEach(async () => {
    const ctx = await makeLocalApp();
    app = ctx.app;
    users = ctx.users;
  });

  async function login(username: string, password: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username, password },
    });
  }

  it('exposes the auth mode without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/mode' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: 'local' });
  });

  it('logs in with valid credentials and uses the token', async () => {
    const res = await login('alice', 'supersecret-password');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.user.username).toBe('alice');

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ username: 'alice', role: 'admin' });

    const servers = await app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(servers.statusCode).toBe(200);
  });

  it('rejects wrong passwords without revealing the reason', async () => {
    const res = await login('alice', 'wrong-password-xyz');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects unknown users the same way', async () => {
    const res = await login('nobody', 'whatever-password');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid credentials' });
  });

  it('requires a token for protected routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('lets admins create users in their own tenant only', async () => {
    const admin = (await login('alice', 'supersecret-password')).json();

    const ok = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { username: 'carol', password: 'carol-secret-pw', role: 'user', tenantId: 't1' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().username).toBe('carol');

    const foreign = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { username: 'dave', password: 'dave-secret-pw12', role: 'user', tenantId: 'other' },
    });
    expect(foreign.statusCode).toBe(403);
  });

  it('forbids plain users from managing accounts', async () => {
    const user = (await login('bob', 'another-secret-pw')).json();
    const res = await app.inject({
      method: 'GET',
      url: '/api/users',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects short passwords and duplicate usernames', async () => {
    const admin = (await login('alice', 'supersecret-password')).json();
    const headers = { authorization: `Bearer ${admin.token}` };

    const short = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers,
      payload: { username: 'erin', password: 'short', role: 'user', tenantId: 't1' },
    });
    expect(short.statusCode).toBe(400);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers,
      payload: { username: 'BOB', password: 'bob-second-secret', role: 'user', tenantId: 't1' },
    });
    expect(dup.statusCode).toBe(400);
  });

  it('deactivates users and their tokens stop working', async () => {
    const admin = (await login('alice', 'supersecret-password')).json();
    const bobToken = (await login('bob', 'another-secret-pw')).json().token;

    const bob = await users.findByUsername('bob');
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/users/${bob?.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(200);

    const relogin = await login('bob', 'another-secret-pw');
    expect(relogin.statusCode).toBe(401);

    const stale = await app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(stale.statusCode).toBe(401);
  });
});
