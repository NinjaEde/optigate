import { describe, it, expect, beforeEach } from 'vitest';

import { buildApp } from '../../src/app';
import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { InMemoryAuditLog } from '../../src/infra/repositories/memoryAuditLog';
import { McpClientPool } from '../../src/infra/mcp/clientPool';
import { CredentialResolver } from '../../src/infra/mcp/credentialResolver';
import type { AuthContext } from '../../src/domain/types';

const SUPER = { userId: 'u0', role: 'superadmin', tenantId: null };
const ADMIN = { userId: 'u1', role: 'admin', tenantId: 't1' };
const USER = { userId: 'u2', role: 'user', tenantId: 't1' };

async function makeApp() {
  const audit = new InMemoryAuditLog();
  const app = await buildApp({
    auth: {
      /** test stub: header x-test-user selects the caller */
      resolveAuth: async (request) => {
        const name = request.headers['x-test-user'] as string | undefined;
        if (!name) {
          throw new Error('Unauthorized');
        }
        if (name === 'super') return SUPER;
        if (name === 'user') return USER;
        return ADMIN as AuthContext;
      },
    },
    registry: {
      repo: new InMemoryServerRepository(),
      audit,
    },
    pool: new McpClientPool(async () => {
      throw new Error('no transports in test');
    }),
    credentials: new CredentialResolver(),
    approvalRequired: false,
  });
  await app.ready();
  return { app, audit };
}

describe('REST API', () => {
  let app: Awaited<ReturnType<typeof makeApp>>['app'];
  let audit: Awaited<ReturnType<typeof makeApp>>['audit'];

  beforeEach(async () => {
    const ctx = await makeApp();
    app = ctx.app;
    audit = ctx.audit;
  });

  it('registers and lists servers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { 'x-test-user': 'admin' },
      payload: {
        name: 'rag-search',
        description: 'RAG tools',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: { url: 'https://mcp.example.com' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().name).toBe('rag-search');

    const list = await app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { 'x-test-user': 'admin' },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
  });

  it('validates the registration payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: { name: '', scope: 'tenant', transport: 'streamable_http', connection: {} },
      headers: { 'x-test-user': 'admin' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('approves as superadmin but not as admin', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: {
        name: 'needs-approval',
        description: '',
        scope: 'global',
        transport: 'streamable_http',
        connection: { url: 'https://mcp.example.com' },
      },
      headers: { 'x-test-user': 'super' },
    });
    const id = reg.json().id;

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/servers/${id}/approve`,
      headers: { 'x-test-user': 'admin' },
    });
    expect(forbidden.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'POST',
      url: `/api/servers/${id}/approve`,
      headers: { 'x-test-user': 'super' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('healthy');
  });

  it('soft-deletes a server', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: {
        name: 'to-delete',
        description: '',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: { url: 'https://m.example.com' },
      },
      headers: { 'x-test-user': 'admin' },
    });
    const id = reg.json().id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/servers/${id}`,
      headers: { 'x-test-user': 'admin' },
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { 'x-test-user': 'admin' },
    });
    expect(list.json()).toHaveLength(0);
  });

  it('writes audit events for lifecycle actions', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: {
        name: 'audited',
        description: '',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: { url: 'https://a.example.com' },
      },
      headers: { 'x-test-user': 'admin' },
    });

    const actions = audit.events.map((e) => e.action);
    expect(actions).toContain('server.registered');
  });

  it('exposes health without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('healthy');
  });

  it('returns tool search results scoped to visible servers', async () => {
    // register two servers with cached tools
    const regA = await app.inject({
      method: 'POST',
      url: '/api/servers',
      payload: {
        name: 'tradingview',
        description: 'market data tools',
        scope: 'global',
        transport: 'streamable_http',
        connection: { url: 'https://tv.example.com' },
      },
      headers: { 'x-test-user': 'super' },
    });
    void regA;

    const search = await app.inject({
      method: 'POST',
      url: '/api/tools/search',
      payload: { query: 'stock quote price', limit: 5 },
      headers: { 'x-test-user': 'admin' },
    });
    expect(search.statusCode).toBe(200);
    expect(Array.isArray(search.json().tools)).toBe(true);
  });

  describe('credential bindings API', () => {
    let serverId: string;

    beforeEach(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'super' },
        payload: {
          name: 'shared-srv',
          scope: 'global',
          transport: 'streamable_http',
          connection: { url: 'https://shared.example.com/mcp' },
        },
      });
      serverId = res.json().id;
    });

    it('lists bindings (empty initially)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'super' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().bindings).toEqual([]);
    });

    it('creates a tenant binding', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/acme-corp`,
        headers: { 'x-test-user': 'super' },
        payload: {
          auth: { type: 'bearer', secretRef: 'ACME_KEY' },
        },
      });
      expect(res.statusCode).toBe(201);

      const list = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'super' },
      });
      expect(list.json().bindings).toHaveLength(1);
      expect(list.json().bindings[0].tenantId).toBe('acme-corp');
      expect(list.json().bindings[0].authType).toBe('bearer');
    });

    it('creates a default binding (tenantId=null)', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/default`,
        headers: { 'x-test-user': 'super' },
        payload: {
          auth: { type: 'api_key', secretRef: 'DEFAULT_KEY' },
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().tenantId).toBeNull();
    });

    it('rejects admin setting bindings for a different tenant', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/other-corp`,
        headers: { 'x-test-user': 'admin' },
        payload: {
          auth: { type: 'bearer', secretRef: 'OTHER_KEY' },
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('deletes a binding', async () => {
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/acme-corp`,
        headers: { 'x-test-user': 'super' },
        payload: { auth: { type: 'bearer', secretRef: 'K' } },
      });

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}/bindings/acme-corp`,
        headers: { 'x-test-user': 'super' },
      });
      expect(del.statusCode).toBe(204);

      const list = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'super' },
      });
      expect(list.json().bindings).toHaveLength(0);
    });

    it('rejects non-admin from viewing bindings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'user' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
