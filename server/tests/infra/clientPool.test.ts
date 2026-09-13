import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  McpClientPool,
  validateArgs,
} from '../../src/infra/mcp/clientPool.js';
import type {
  AuthContext,
  MCPServer,
} from '../../src/domain/types.js';
import type { McpTransport } from '../../src/infra/mcp/clientPool.js';

const ctx = (tenantId: string | null): AuthContext => ({
  userId: 'u1',
  role: 'admin',
  tenantId,
});

function makeServer(id: string): MCPServer {
  return {
    id,
    tenantId: null,
    name: `srv-${id}`,
    description: '',
    scope: 'global',
    ownerId: null,
    transport: 'streamable_http',
    connection: { url: `https://${id}.example.com/mcp` },
    status: 'healthy',
    createdBy: 'tester',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  } as MCPServer;
}

interface MockTransport extends McpTransport {
  connectCount: number;
  closed: boolean;
}

function makeFactory() {
  const transports: MockTransport[] = [];
  const factory = vi.fn(async (): Promise<MockTransport> => {
    const t: MockTransport = {
      connectCount: 0,
      closed: false,
      async connect() {
        t.connectCount++;
      },
      async close() {
        t.closed = true;
      },
      async listTools() {
        return [];
      },
      async callTool() {
        return {};
      },
    };
    transports.push(t);
    return t;
  });
  return { factory, transports };
}

describe('McpClientPool — tenant-scoped connections', () => {
  let pool: McpClientPool;
  let factoryInfo: ReturnType<typeof makeFactory>;
  const server = makeServer('srv-1');

  beforeEach(() => {
    factoryInfo = makeFactory();
    pool = new McpClientPool(factoryInfo.factory);
  });

  it('creates SEPARATE connections per tenant for the same server', async () => {
    await pool.callTool(server, ctx('acme'), 't', {});
    await pool.callTool(server, ctx('globex'), 't', {});

    // two distinct transports spawned
    expect(factoryInfo.transports).toHaveLength(2);
  });

  it('REUSES the connection within the same tenant scope', async () => {
    await pool.callTool(server, ctx('acme'), 't', {});
    await pool.callTool(server, ctx('acme'), 't', {});

    expect(factoryInfo.transports).toHaveLength(1);
  });

  it('callers without tenant share one default-scope connection', async () => {
    await pool.callTool(server, ctx(null), 't', {});
    await pool.callTool(server, ctx(null), 't', {});

    expect(factoryInfo.transports).toHaveLength(1);
  });

  it('concurrent first-use callers share one connection attempt', async () => {
    const results = await Promise.all([
      pool.callTool(server, ctx('acme'), 't', {}),
      pool.callTool(server, ctx('acme'), 't', {}),
      pool.callTool(server, ctx('acme'), 't', {}),
    ]);

    expect(results).toHaveLength(3);
    // a single transport spawned — no leaked duplicates
    expect(factoryInfo.transports).toHaveLength(1);
    expect(factoryInfo.factory).toHaveBeenCalledTimes(1);
  });

  it('closes half-open transports when connect fails', async () => {
    const created: MockTransport[] = [];
    const failing = vi.fn(async (): Promise<MockTransport> => {
      const t: MockTransport = {
        connectCount: 0,
        closed: false,
        async connect() {
          throw new Error('refused');
        },
        async close() {
          t.closed = true;
        },
        async listTools() {
          return [];
        },
        async callTool() {
          return {};
        },
      };
      created.push(t);
      return t;
    });
    const failingPool = new McpClientPool(failing);
    await expect(
      failingPool.callTool(server, ctx('acme'), 't', {}),
    ).rejects.toThrow(/refused/);
    expect(created).toHaveLength(1);
    expect(created[0].closed).toBe(true);
  });

  it('scopes the tool cache per tenant instead of sharing it', async () => {
    let n = 0;
    const scoped = vi.fn(async (): Promise<MockTransport> => {
      n++;
      const tag = `tool-${n}`;
      const t: MockTransport = {
        connectCount: 0,
        closed: false,
        async connect() {},
        async close() {
          t.closed = true;
        },
        async listTools() {
          return [{ name: tag }];
        },
        async callTool() {
          return {};
        },
      };
      return t;
    });
    const scopedPool = new McpClientPool(scoped);

    await scopedPool.syncTools(server, ctx('acme'));
    await scopedPool.syncTools(server, ctx('globex'));

    expect(scopedPool.cachedTools(server.id, ctx('acme')).map((t) => t.name)).toEqual([
      'tool-1',
    ]);
    expect(scopedPool.cachedTools(server.id, ctx('globex')).map((t) => t.name)).toEqual([
      'tool-2',
    ]);

    // disconnecting one tenant leaves the other's cache intact
    await scopedPool.disconnect(server.id, ctx('acme'));
    expect(scopedPool.cachedTools(server.id, ctx('acme'))).toEqual([]);
    expect(scopedPool.cachedTools(server.id, ctx('globex')).map((t) => t.name)).toEqual([
      'tool-2',
    ]);
  });

  it('evicts broken transports on callTool failure', async () => {
    const failing = vi.fn(async (): Promise<MockTransport> => {
      const t: MockTransport = {
        connectCount: 0,
        closed: false,
        async connect() {},
        async close() {
          t.closed = true;
        },
        async listTools() {
          return [];
        },
        async callTool() {
          throw new Error('boom');
        },
      };
      return t;
    });
    const failingPool = new McpClientPool(failing);

    await expect(
      failingPool.callTool(server, ctx('acme'), 't', {}),
    ).rejects.toThrow(/boom/);
    // next call must not reuse the broken transport
    await expect(
      failingPool.callTool(server, ctx('acme'), 't', {}),
    ).rejects.toThrow(/boom/);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  describe('maxConnectionsPerServer (LRU eviction)', () => {
    it('evicts the least recently used tenant connection beyond the limit', async () => {
      const limited = new McpClientPool(factoryInfo.factory, {
        maxConnectionsPerServer: 2,
      });

      await limited.callTool(server, ctx('t1'), 't', {});
      await limited.callTool(server, ctx('t2'), 't', {});

      const t1Conn = factoryInfo.transports[0];
      const t2Conn = factoryInfo.transports[1];

      // touch t1 again → t2 becomes the LRU
      await limited.callTool(server, ctx('t1'), 't', {});

      // third tenant triggers eviction of t2's connection
      await limited.callTool(server, ctx('t3'), 't', {});

      // only t3 was newly created; exactly one of t1/t2 got evicted
      const openCount = factoryInfo.transports.filter((tr) => !tr.closed).length;
      expect(openCount).toBe(2);
      expect(factoryInfo.transports).toHaveLength(3);
      expect(t1Conn.closed).toBe(false); // t1 was touched, stays open
      expect(t2Conn.closed).toBe(true); // LRU evicted
    });
  });

  describe('disconnect', () => {
    it('closes only the caller-scoped connection', async () => {
      await pool.callTool(server, ctx('acme'), 't', {});
      await pool.callTool(server, ctx('globex'), 't', {});
      const acmeConn = factoryInfo.transports[0];
      const globexConn = factoryInfo.transports[1];

      await pool.disconnect('srv-1', ctx('acme'));

      expect(acmeConn.closed).toBe(true);
      expect(globexConn.closed).toBe(false);

      // next acme call spawns a fresh connection
      await pool.callTool(server, ctx('acme'), 't', {});
      expect(factoryInfo.transports).toHaveLength(3);
    });
  });
});

describe('validateArgs', () => {
  it('accepts valid args matching the schema', () => {
    expect(() =>
      validateArgs('my-tool', { name: 'foo', count: 3 }, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, count: { type: 'integer' } },
      }),
    ).not.toThrow();
  });

  it('rejects missing required fields', () => {
    expect(() =>
      validateArgs('my-tool', { count: 3 }, {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, count: { type: 'integer' } },
      }),
    ).toThrow(/missing required argument "name"/);
  });

  it('rejects prototype members as required fields', () => {
    // 'toString' in {} is true via the prototype chain — must not pass
    expect(() =>
      validateArgs('my-tool', {}, {
        type: 'object',
        required: ['toString'],
      }),
    ).toThrow(/missing required argument "toString"/);
  });

  it('rejects wrong types', () => {
    expect(() =>
      validateArgs('my-tool', { name: 42 }, {
        type: 'object',
        properties: { name: { type: 'string' } },
      }),
    ).toThrow(/argument "name" must be a string/);
  });

  it('accepts args without schema (loose mode)', () => {
    expect(() => validateArgs('my-tool', { anything: 1 }, undefined)).not.toThrow();
  });

  it('accepts args with empty schema', () => {
    expect(() => validateArgs('my-tool', {}, { type: 'object' })).not.toThrow();
  });

  it('rejects wrong type for boolean', () => {
    expect(() =>
      validateArgs('my-tool', { flag: 'yes' }, {
        type: 'object',
        properties: { flag: { type: 'boolean' } },
      }),
    ).toThrow(/argument "flag" must be a boolean/);
  });

  it('rejects wrong type for array', () => {
    expect(() =>
      validateArgs('my-tool', { items: 'not-an-array' }, {
        type: 'object',
        properties: { items: { type: 'array' } },
      }),
    ).toThrow(/argument "items" must be an array/);
  });
});
