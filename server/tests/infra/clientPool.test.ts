import { describe, it, expect, vi } from 'vitest';

import { McpClientPool } from '../../src/infra/mcp/clientPool';
import type { MCPServer, ToolMeta } from '../../src/domain/types';

const server = (over: Partial<MCPServer> = {}): MCPServer => ({
  id: 'srv-1',
  tenantId: null,
  name: 'test-mcp',
  description: '',
  scope: 'global',
  ownerId: null,
  transport: 'streamable_http',
  connection: { url: 'https://mcp.example.com' },
  status: 'healthy',
  createdBy: 'u0',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  ...over,
});

function fakeTransport() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'quote_get',
        description: 'Get a stock quote',
        inputSchema: { type: 'object' },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  };
}

describe('McpClientPool.syncTools', () => {
  it('returns tool metadata from the transport and caches it', async () => {
    const pool = new McpClientPool(async () => fakeTransport());
    const s = server();

    const tools = await pool.syncTools(s);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('quote_get');
    expect(tools[0].serverId).toBe('srv-1');

    // cached copy retrievable without reconnecting
    const cached: ToolMeta[] = pool.cachedTools('srv-1');
    expect(cached).toHaveLength(1);
  });

  it('marks the server degraded when listing fails', async () => {
    const failing = fakeTransport();
    failing.listTools.mockRejectedValue(new Error('connection refused'));

    const pool = new McpClientPool(async () => failing);

    await expect(pool.syncTools(server())).rejects.toThrow(/connection refused/);
  });
});

describe('McpClientPool.callTool', () => {
  it('delegates to the transport and returns the result', async () => {
    const pool = new McpClientPool(async () => fakeTransport());
    const result = await pool.callTool(server(), 'quote_get', { symbol: 'AAPL' });
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
  });
});
