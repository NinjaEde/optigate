import { describe, it, expect, beforeEach } from 'vitest';

import { buildApp } from '../../src/app';
import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { InMemoryAuditLog } from '../../src/infra/repositories/memoryAuditLog';
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
    approvalRequired: false,
  });
  await app.ready();
  return app;
}

describe('Multi-tenant credential isolation', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;

  beforeEach(async () => {
    process.env.SECRET_ENCRYPTION_KEY = 'test-encryption-key-32-chars!!';
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
  });
});
