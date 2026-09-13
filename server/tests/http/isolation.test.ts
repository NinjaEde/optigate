import { describe, it, expect, beforeEach } from 'vitest';

import { buildApp } from '../../src/app';
import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { InMemoryAuditLog } from '../../src/infra/repositories/memoryAuditLog';
import { InMemoryApiKeyStore } from '../../src/infra/repositories/memoryApiKeyStore';
import { ApiKeyService } from '../../src/services/apiKeyService';
import { McpClientPool } from '../../src/infra/mcp/clientPool';
import { CredentialResolver } from '../../src/infra/mcp/credentialResolver';
import type { AuthContext } from '../../src/domain/types';

async function makeApp() {
  const audit = new InMemoryAuditLog();
  const app = await buildApp({
    auth: {
      resolveAuth: async (request: { headers: Record<string, unknown> }) => {
        // header-based test identity (same shape as dev mode)
        return {
          userId: String(request.headers['x-test-user'] ?? 'anon'),
          role: (request.headers['x-test-role'] as AuthContext['role']) ?? 'user',
          tenantId: (request.headers['x-test-tenant'] as string) ?? null,
        };
      },
    },
    registry: { repo: new InMemoryServerRepository(), audit },
    pool: new McpClientPool(async () => {
      throw new Error('no transports in test');
    }),
    credentials: new CredentialResolver(),
    apiKeys: new ApiKeyService(new InMemoryApiKeyStore(), audit),
    approvalRequired: false,
  });
  await app.ready();
  return app;
}

describe('Multi-tenant credential isolation', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    process.env.SECRET_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!!!';
    app = await makeApp();
  });

  it('rejects shared=true for non-superadmins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
      payload: {
        name: 'sneaky-shared',
        description: '',
        scope: 'tenant',
        shared: true,
        transport: 'streamable_http',
        connection: { url: 'https://x.example.com' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('superadmin');
  });

    it('rejects stdio servers for non-superadmins (process spawning)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: {
          name: 'evil-stdio',
          description: '',
          scope: 'tenant',
          transport: 'stdio',
          connection: { command: 'sh', args: ['-c', 'id'] },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('superadmin');
    });

    it('allows stdio servers for superadmins but locks reconfiguration', async () => {
      const reg = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'u0', 'x-test-role': 'superadmin' },
        payload: {
          name: 'local-tool',
          description: '',
          scope: 'private',
          transport: 'stdio',
          connection: { command: 'node', args: ['server.js'] },
        },
      });
      expect(reg.statusCode).toBe(201);
      const id = reg.json().id as string;

      // tenant admin may neither switch transports to stdio ...
      const httpReg = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: {
          name: 'plain-http',
          description: '',
          scope: 'tenant',
          transport: 'streamable_http',
          connection: { url: 'https://h.example.com' },
        },
      });
      const httpId = httpReg.json().id as string;
      const escalate = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${httpId}`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: { transport: 'stdio', connection: { command: 'sh' } },
      });
      expect(escalate.statusCode).toBe(403);

      // ... but metadata edits on other servers still work
      const meta = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${httpId}`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: { description: 'still fine' },
      });
      expect(meta.statusCode).toBe(200);
      void id;
    });

    it('rejects shared stdio servers even for superadmins', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { 'x-test-user': 'u0', 'x-test-role': 'superadmin' },
      payload: {
        name: 'shared-stdio',
        description: '',
        scope: 'global',
        shared: true,
        transport: 'stdio',
        connection: { command: 'node', args: ['server.js'] },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('cannot be shared');
  });

  it('accepts a shared HTTP server from a superadmin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers',
      headers: { 'x-test-user': 'u0', 'x-test-role': 'superadmin' },
      payload: {
        name: 'shared-tavily',
        description: '',
        scope: 'tenant',
        shared: true,
        transport: 'streamable_http',
        connection: { url: 'https://tavily.example.com/mcp' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().shared).toBe(true);
  });

  describe('bindings API', () => {
    let serverId: string;

    beforeEach(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'u0', 'x-test-role': 'superadmin' },
        payload: {
          name: 'binding-target',
          description: '',
          scope: 'tenant',
          shared: true,
          transport: 'streamable_http',
          connection: { url: 'https://target.example.com/mcp' },
        },
      });
      serverId = res.json().id;
    });

    it('sets and lists a binding without leaking secrets', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/t1`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: {
          auth: { type: 'bearer', secretPlaintext: 'super-secret-value' },
        },
      });
      expect(put.statusCode).toBe(201);

      const list = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
      });
      expect(list.statusCode).toBe(200);
      const body = JSON.stringify(list.json());
      expect(body).not.toContain('super-secret-value');
      expect(body).not.toContain('secretEnc');

      // default binding appears once set
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/default`,
        headers: { 'x-test-user': 'u0', 'x-test-role': 'superadmin' },
        payload: { auth: { type: 'api_key', secretRef: 'PLATFORM_KEY' } },
      });
      const after = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
      });
      const tenants = after.json().bindings.map((b: { tenantId: string | null }) => b.tenantId);
      expect(tenants).toContain('t1');
      expect(tenants).toContain(null);
    });

    it("forbids admins touching other tenants' bindings", async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/other-corp`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: { auth: { type: 'bearer', secretRef: 'NOT_MINE' } },
      });
      expect(res.statusCode).toBe(403);
    });

    it('forbids plain users entirely', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'u9', 'x-test-role': 'user', 'x-test-tenant': 't1' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('hides other tenants bindings from admins', async () => {
      process.env.SECRET_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!!!';
      await app.inject({
        method: 'PUT',
        url: `/api/servers/${serverId}/bindings/t2`,
        headers: { 'x-test-user': 'u0', 'x-test-role': 'superadmin' },
        payload: { auth: { type: 'bearer', secretRef: 'T2_KEY' } },
      });

      const list = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}/bindings`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
      });
      expect(list.statusCode).toBe(200);
      const tenants = list.json().bindings.map((b: { tenantId: string | null }) => b.tenantId);
      expect(tenants).not.toContain('t2');
      expect(JSON.stringify(list.json())).not.toContain('T2_KEY');
    });
  });

  describe('write-operation authorization', () => {
    let serverId: string;

    beforeEach(async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
        payload: {
          name: 'tenant-srv',
          description: '',
          scope: 'tenant',
          transport: 'streamable_http',
          connection: { url: 'https://tenant.example.com/mcp' },
        },
      });
      serverId = res.json().id;
    });

    it('forbids plain users from updating, disabling or deleting', async () => {
      const user = { 'x-test-user': 'u9', 'x-test-role': 'user', 'x-test-tenant': 't1' };

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: user,
        payload: { description: 'hijacked' },
      });
      expect(patch.statusCode).toBe(403);

      const disable = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/disable`,
        headers: user,
      });
      expect(disable.statusCode).toBe(403);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}`,
        headers: user,
      });
      expect(del.statusCode).toBe(404);

      // server untouched
      const get = await app.inject({
        method: 'GET',
        url: `/api/servers/${serverId}`,
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' },
      });
      expect(get.json().description).toBe('');
    });

    it('forbids admins of other tenants', async () => {
      const other = { 'x-test-user': 'u7', 'x-test-role': 'admin', 'x-test-tenant': 't2' };

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: other,
        payload: { description: 'cross-tenant' },
      });
      expect(patch.statusCode).toBe(400);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/servers/${serverId}`,
        headers: other,
      });
      expect(del.statusCode).toBe(404);
    });

    it('forbids plain users from validate, refresh and disconnect', async () => {
      const user = { 'x-test-user': 'u9', 'x-test-role': 'user', 'x-test-tenant': 't1' };

      const validate = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/validate`,
        headers: user,
      });
      expect(validate.statusCode).toBe(403);

      const refresh = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/tools/refresh`,
        headers: user,
      });
      expect(refresh.statusCode).toBe(403);

      // disconnect flips server-global status/index: 404 to hide existence
      const disconnect = await app.inject({
        method: 'POST',
        url: `/api/servers/${serverId}/disconnect`,
        headers: user,
      });
      expect(disconnect.statusCode).toBe(404);
    });

    it('allows the owning tenant admin', async () => {
      const admin = { 'x-test-user': 'u1', 'x-test-role': 'admin', 'x-test-tenant': 't1' };

      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/servers/${serverId}`,
        headers: admin,
        payload: { description: 'legit update' },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json().description).toBe('legit update');
    });

    it('rejects tenant-scoped registration without a tenant identity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers',
        headers: { 'x-test-user': 'u1', 'x-test-role': 'admin' },
        payload: {
          name: 'tenantless',
          description: '',
          scope: 'tenant',
          transport: 'streamable_http',
          connection: { url: 'https://nowhere.example.com' },
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('tenant');
    });
  });
});
