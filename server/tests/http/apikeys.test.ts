import { describe, it, expect, beforeEach } from 'vitest';

import { buildApp } from '../../src/app';
import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { InMemoryAuditLog } from '../../src/infra/repositories/memoryAuditLog';
import { InMemoryApiKeyStore } from '../../src/infra/repositories/memoryApiKeyStore';
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
  const apiKeys = new ApiKeyService(new InMemoryApiKeyStore(), audit);
  const app = await buildApp({
    auth: {
      /**
       * Mirrors the production chain in src/index.ts: x-api-key first
       * (gateway-only identity), header identity otherwise.
       */
      resolveAuth: async (request) => {
        const presented = request.headers['x-api-key'] as string | undefined;
        if (presented) {
          const found = await apiKeys.verifyKey(presented);
          if (!found) {
            throw new Error('Unauthorized');
          }
          return {
            userId: found.userId,
            role: found.role,
            tenantId: found.tenantId,
            viaApiKey: true as const,
          };
        }
        return identity(request.headers['x-test-user'] as string | undefined);
      },
    },
    registry: { repo: new InMemoryServerRepository(), audit },
    pool: new McpClientPool(async () => {
      throw new Error('no transports in test');
    }),
    credentials: new CredentialResolver(),
    apiKeys,
    approvalRequired: false,
  });
  await app.ready();
  return { app, audit, apiKeys };
}

describe('Gateway API keys', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let audit: Awaited<ReturnType<typeof makeApp>>['audit'];

  beforeEach(async () => {
    const ctx = await makeApp();
    app = ctx.app;
    audit = ctx.audit;
  });

  async function createKey(
    user: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { 'x-test-user': user },
      payload,
    });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  }

  it('admin creates a key for their own tenant; secret shown once, hash never exposed', async () => {
    const { status, body } = await createKey('admin', {
      name: 'agent-1',
      role: 'user',
      tenantId: 't1',
    });
    expect(status).toBe(201);

    const key = body.key as Record<string, unknown>;
    const secret = body.secret as string;
    expect(typeof secret).toBe('string');
    expect(secret.startsWith('og_')).toBe(true);
    expect(key.name).toBe('agent-1');
    // the key object itself never carries hash or secret material
    expect(key).not.toHaveProperty('keyHash');
    expect(JSON.stringify(key)).not.toContain(secret.slice(3));

    // ... and neither does the key listing afterwards
    const list = await app.inject({
      method: 'GET',
      url: '/api/api-keys',
      headers: { 'x-test-user': 'admin' },
    });
    expect(JSON.stringify(list.json())).not.toContain(secret.slice(3));

    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain('apikey.created');
  });

  it('key authenticates on /mcp but is rejected on /api', async () => {
    const { body } = await createKey('admin', {
      name: 'mcp-only',
      role: 'user',
      tenantId: 't1',
    });
    const secret = body.secret as string;

    const init = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-api-key': secret },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {} },
      },
    });
    expect(init.statusCode).toBe(200);
    expect(init.json().result.serverInfo.name).toBe('optigate');

    const denied = await app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { 'x-api-key': secret },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('rejects unknown, revoked and expired keys on /mcp', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-api-key': 'og_nonexistent-secret-value-xyz' },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(bad.statusCode).toBe(401);

    const { body } = await createKey('admin', {
      name: 'short-lived',
      role: 'user',
      tenantId: 't1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const expired = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-api-key': body.secret as string },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(expired.statusCode).toBe(401);

    const fresh = await createKey('admin', {
      name: 'doomed',
      role: 'user',
      tenantId: 't1',
    });
    const keyId = (fresh.body.key as { id: string }).id;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/api-keys/${keyId}`,
      headers: { 'x-test-user': 'admin' },
    });
    expect(del.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-api-key': fresh.body.secret as string },
      payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(revoked.statusCode).toBe(401);
    expect(audit.events.map((e) => e.action)).toContain('apikey.revoked');
  });

  it('admin cannot create keys for other tenants or above their role; users cannot create', async () => {
    const other = await createKey('admin', {
      name: 'cross',
      role: 'user',
      tenantId: 't2',
    });
    expect(other.status).toBe(403);

    const elevated = await createKey('admin', {
      name: 'elevated',
      role: 'superadmin',
      tenantId: 't1',
    });
    expect(elevated.status).toBe(403);

    const byUser = await createKey('user', {
      name: 'userkey',
      role: 'user',
      tenantId: 't1',
    });
    expect(byUser.status).toBe(403);
  });

  it('keys cannot manage keys; listing is tenant-scoped', async () => {
    const { body } = await createKey('admin', {
      name: 'selfish',
      role: 'user',
      tenantId: 't1',
    });

    const nested = await app.inject({
      method: 'POST',
      url: '/api/api-keys',
      headers: { 'x-api-key': body.secret as string },
      payload: { name: 'nested', role: 'user', tenantId: 't1' },
    });
    expect(nested.statusCode).toBe(403);

    await createKey('super', {
      name: 'platform',
      role: 'superadmin',
    });

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/api-keys',
      headers: { 'x-test-user': 'admin' },
    });
    expect(adminList.statusCode).toBe(200);
    const adminNames = (adminList.json().keys as Array<{ name: string }>).map(
      (k) => k.name,
    );
    expect(adminNames).toContain('selfish');
    expect(adminNames).not.toContain('platform');

    const superList = await app.inject({
      method: 'GET',
      url: '/api/api-keys',
      headers: { 'x-test-user': 'super' },
    });
    expect(
      (superList.json().keys as Array<{ name: string }>).map((k) => k.name),
    ).toContain('platform');
  });

  it('admin cannot revoke another tenant key', async () => {
    const { body } = await createKey('super', {
      name: 'other-tenant-key',
      role: 'admin',
      tenantId: 't9',
    });
    const keyId = (body.key as { id: string }).id;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/api-keys/${keyId}`,
      headers: { 'x-test-user': 'admin' },
    });
    expect(res.statusCode).toBe(403);
  });
});
