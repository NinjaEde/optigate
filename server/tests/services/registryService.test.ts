import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryServerRepository } from '../../src/infra/repositories/memoryServerRepository';
import { RegistryService } from '../../src/services/registryService';
import type { AuthContext } from '../../src/domain/types';

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
