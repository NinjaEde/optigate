import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { RegistryService } from '../../src/services/registryService';
import { ForbiddenError } from '../../src/services/errors';
import type { AuthContext } from '../../src/domain/types';
import type { SearchableTool } from '../../src/domain/toolSearch';

const authAdmin: AuthContext = { userId: 'u1', role: 'admin', tenantId: 't1' };
const authSuper: AuthContext = { userId: 'u0', role: 'superadmin', tenantId: null };

function makeService(): RegistryService {
  return new RegistryService(new InMemoryServerRepository(), {
    approvalRequired: false,
  });
}

describe('RegistryService.registerServer', () => {
  let service: RegistryService;

  beforeEach(() => {
    service = makeService();
  });

  it('registers a healthy server with valid config', async () => {
    const created = await service.registerServer(authAdmin, {
      name: 'rag-search',
      description: 'Tenant RAG tools',
      scope: 'tenant',
      transport: 'streamable_http',
      connection: { url: 'https://mcp.example.com/rpc' },
    });

    expect(created.id).toBeTruthy();
    expect(created.status).toBe('healthy');
    expect(created.tenantId).toBe('t1');
  });

  it('rejects duplicate names within the same tenant', async () => {
    const input = {
      name: 'dup',
      description: '',
      scope: 'tenant' as const,
      transport: 'streamable_http' as const,
      connection: { url: 'https://dup.example.com' },
    };
    await service.registerServer(authAdmin, input);
    await expect(service.registerServer(authAdmin, input)).rejects.toThrow(
      /already exists/i,
    );
  });

  it('rejects http transports without a url', async () => {
    await expect(
      service.registerServer(authAdmin, {
        name: 'broken',
        description: '',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: {},
      }),
    ).rejects.toThrow(/url/i);
  });

  it('rejects plain users from registering', async () => {
    await expect(
      service.registerServer({ userId: 'u2', role: 'user', tenantId: 't1' }, {
        name: 'nope',
        description: '',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: { url: 'https://x.example.com' },
      }),
    ).rejects.toThrow(/not allowed/i);
  });
});

describe('RegistryService.listServersFor', () => {
  it('hides other tenants servers and soft-deleted ones', async () => {
    await service_registerTwo();

    async function service_registerTwo() {
      await makeService().registerServer(authAdmin, {
        name: 'mine',
        description: '',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: { url: 'https://a.example.com' },
      });
    }

    // independent service for the cross-tenant check
    const svc = makeService();
    const mine = await svc.registerServer(authAdmin, {
      name: 'visible',
      description: '',
      scope: 'tenant',
      transport: 'streamable_http',
      connection: { url: 'https://a.example.com' },
    });
    await svc.registerServer(authSuper, {
      name: 'other-tenant',
      description: '',
      scope: 'global',
      transport: 'streamable_http',
      connection: { url: 'https://b.example.com' },
    });
    void mine;
    const list = await svc.listServersFor(authAdmin);
    expect(list.map((s) => s.name)).toContain('other-tenant');
    expect(list.map((s) => s.name)).toContain('visible');

    // soft delete hides it
    await svc.deleteServer(authAdmin, mine.id);
    const after = await svc.listServersFor(authAdmin);
    expect(after.find((s) => s.id === mine.id)).toBeUndefined();
  });
});

describe('RegistryService.manage authorization', () => {
  it('rejects updates and deletes by plain users', async () => {
    const svc = makeService();
    const srv = await svc.registerServer(authAdmin, {
      name: 'managed',
      description: '',
      scope: 'tenant',
      transport: 'streamable_http',
      connection: { url: 'https://a.example.com' },
    });
    const user: AuthContext = { userId: 'u2', role: 'user', tenantId: 't1' };

    // policy denials are typed so HTTP handlers can map status codes
    await expect(
      svc.updateServer(user, srv.id, { description: 'x' }),
    ).rejects.toThrow(ForbiddenError);
    await expect(svc.disableServer(user, srv.id)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(svc.deleteServer(user, srv.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('rejects tenant-scoped registration without a tenant', async () => {
    await expect(
      makeService().registerServer(authSuper, {
        name: 'tenantless',
        description: '',
        scope: 'tenant',
        transport: 'streamable_http',
        connection: { url: 'https://a.example.com' },
      }),
    ).rejects.toThrow(/tenant/i);
  });
});

describe('RegistryService.updateServer secret handling', () => {
  async function seed() {
    const svc = makeService();
    const srv = await svc.registerServer(authAdmin, {
      name: 'vaulted',
      description: '',
      scope: 'tenant',
      transport: 'streamable_http',
      connection: {
        url: 'https://v.example.com',
        auth: { type: 'bearer', secretEnc: 'enc:v1:stored' },
        customHeaders: { 'X-Tenant': 'real-value' },
      },
    });
    return { svc, srv };
  }

  it('preserves stored secrets on metadata-only patches', async () => {
    const { svc, srv } = await seed();
    const updated = await svc.updateServer(authAdmin, srv.id, {
      description: 'new text',
    });
    expect(updated.connection.auth?.secretEnc).toBe('enc:v1:stored');
    expect(updated.connection.customHeaders).toEqual({
      'X-Tenant': 'real-value',
    });
  });

  it('replaces secrets explicitly and drops stale counterparts', async () => {
    const { svc, srv } = await seed();
    const updated = await svc.updateServer(authAdmin, srv.id, {
      connection: {
        url: 'https://v.example.com',
        auth: { type: 'bearer', secretRef: 'NEW_REF' },
      },
    });
    expect(updated.connection.auth?.secretRef).toBe('NEW_REF');
    expect(updated.connection.auth?.secretEnc).toBeUndefined();
  });

  it('keeps stored customHeader values behind the marker', async () => {
    const { svc, srv } = await seed();
    const updated = await svc.updateServer(authAdmin, srv.id, {
      connection: {
        url: 'https://v.example.com',
        customHeaders: { 'X-Tenant': '__stored__', 'X-New': 'fresh' },
      },
    });
    expect(updated.connection.customHeaders).toEqual({
      'X-Tenant': 'real-value',
      'X-New': 'fresh',
    });
  });
});

describe('RegistryService.searchToolsFor', () => {
  it('only returns tools of healthy servers', async () => {
    const svc = makeService();
    const healthy = await svc.registerServer(authAdmin, {
      name: 'up',
      description: '',
      scope: 'tenant',
      transport: 'streamable_http',
      connection: { url: 'https://up.example.com' },
    });
    const down = await svc.registerServer(authAdmin, {
      name: 'down',
      description: '',
      scope: 'tenant',
      transport: 'streamable_http',
      connection: { url: 'https://down.example.com' },
    });
    await svc.disableServer(authSuper, down.id);

    const tool = (serverId: string, name: string): SearchableTool => ({
      serverId,
      serverName: serverId,
      name,
      description: `${name} tool`,
      inputSchema: {},
      lastSeenAt: new Date().toISOString(),
    });

    const results = await svc.searchToolsFor(authAdmin, 'tool', 10, async () => [
      tool(healthy.id, 'tool_alpha'),
      tool(down.id, 'tool_beta'),
    ]);

    expect(results.map((r) => r.name)).toContain('tool_alpha');
    expect(results.map((r) => r.name)).not.toContain('tool_beta');
  });
});
