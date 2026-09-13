import { describe, it, expect, beforeEach } from 'vitest';

import { buildApp } from '../../src/app';
import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { InMemoryAuditLog } from '../../src/infra/repositories/memoryAuditLog';
import { InMemoryApiKeyStore } from '../../src/infra/repositories/memoryApiKeyStore';
import { InMemorySettingsStore } from '../../src/infra/repositories/memorySettingsStore';
import { SettingsService } from '../../src/services/settingsService';
import { ApiKeyService } from '../../src/services/apiKeyService';
import { McpClientPool } from '../../src/infra/mcp/clientPool';
import { CredentialResolver } from '../../src/infra/mcp/credentialResolver';
import type { AuthContext } from '../../src/domain/types';

const SUPER: AuthContext = { userId: 'u0', role: 'superadmin', tenantId: null };
const ADMIN: AuthContext = { userId: 'u1', role: 'admin', tenantId: 't1' };
const USER: AuthContext = { userId: 'u2', role: 'user', tenantId: 't1' };

function identity(name: string | undefined): AuthContext {
  if (name === 'super') return SUPER;
  if (name === 'user') return USER;
  if (name === 'admin') return ADMIN;
  throw new Error('Unauthorized');
}

async function makeApp() {
  const audit = new InMemoryAuditLog();
  const app = await buildApp({
    auth: {
      resolveAuth: async (request) =>
        identity(request.headers['x-test-user'] as string | undefined),
    },
    registry: { repo: new InMemoryServerRepository(), audit },
    pool: new McpClientPool(async () => {
      throw new Error('no transports in test');
    }),
    credentials: new CredentialResolver(),
    apiKeys: new ApiKeyService(new InMemoryApiKeyStore(), audit),
    settings: new SettingsService(new InMemorySettingsStore(), audit),
    approvalRequired: false,
  });
  await app.ready();
  return { app, audit };
}

describe('Settings API', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let audit: Awaited<ReturnType<typeof makeApp>>['audit'];

  beforeEach(async () => {
    const ctx = await makeApp();
    app = ctx.app;
    audit = ctx.audit;
  });

  it('lists settings for admins but not users', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { 'x-test-user': 'admin' },
    });
    expect(ok.statusCode).toBe(200);
    const keys = (ok.json().settings as Array<{ key: string }>).map((s) => s.key);
    expect(keys).toContain('ratelimit.max');
    expect(keys).toContain('ssrf.allowPrivateRanges');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { 'x-test-user': 'user' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('admin sets operational keys; superadmin-only keys rejected for admins', async () => {
    const ok = await app.inject({
      method: 'PUT',
      url: '/api/settings/ratelimit.max',
      headers: { 'x-test-user': 'admin' },
      payload: { value: 500 },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().value).toBe(500);
    expect(ok.json().source).toBe('db');

    const forbidden = await app.inject({
      method: 'PUT',
      url: '/api/settings/ssrf.allowPrivateRanges',
      headers: { 'x-test-user': 'admin' },
      payload: { value: true },
    });
    expect(forbidden.statusCode).toBe(403);

    const superOk = await app.inject({
      method: 'PUT',
      url: '/api/settings/ssrf.allowPrivateRanges',
      headers: { 'x-test-user': 'super' },
      payload: { value: true },
    });
    expect(superOk.statusCode).toBe(200);

    expect(audit.events.map((e) => e.action)).toContain('setting.changed');
  });

  it('rejects unknown keys and invalid values', async () => {
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/settings/nope.nothing',
      headers: { 'x-test-user': 'super' },
      payload: { value: 1 },
    });
    expect(unknown.statusCode).toBe(404);

    const badType = await app.inject({
      method: 'PUT',
      url: '/api/settings/ratelimit.max',
      headers: { 'x-test-user': 'super' },
      payload: { value: 'fast' },
    });
    expect(badType.statusCode).toBe(400);

    const outOfRange = await app.inject({
      method: 'PUT',
      url: '/api/settings/ratelimit.max',
      headers: { 'x-test-user': 'super' },
      payload: { value: 0 },
    });
    expect(outOfRange.statusCode).toBe(400);
  });

  it('reset deletes the override', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/audit.limit',
      headers: { 'x-test-user': 'super' },
      payload: { value: 50 },
    });

    const reset = await app.inject({
      method: 'DELETE',
      url: '/api/settings/audit.limit',
      headers: { 'x-test-user': 'super' },
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().value).toBe(100);
    expect(reset.json().source).toBe('default');
  });
});
