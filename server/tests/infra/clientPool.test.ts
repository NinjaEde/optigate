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
