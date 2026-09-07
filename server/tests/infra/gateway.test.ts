import { describe, it, expect, vi } from 'vitest';
import { createMcpGateway } from '../../src/infra/mcp/gateway.js';

function makeOptions() {
  const auth = { userId: 'u1', role: 'superadmin' as const, tenantId: null };
  return {
    resolveAuth: vi.fn().mockResolvedValue(auth),
    listVisibleServers: vi.fn().mockResolvedValue([
      { id: 's1', name: 'Alpha', status: 'healthy' },
    ]),
    buildToolIndex: vi.fn().mockResolvedValue([
      { serverId: 's1', serverName: 'Alpha', name: 'greet', description: 'Say hello', inputSchema: {} },
      { serverId: 's1', serverName: 'Alpha', name: 'echo', description: 'Echo input', inputSchema: {} },
    ]),
    searchTools: vi.fn().mockImplementation(
      (tools: unknown[], query: string, limit: number) =>
        (tools as Array<{ name: string }>)
          .filter((t) => t.name.includes(query))
          .slice(0, limit)
          .map((t) => ({ ...t, score: 1 })),
    ),
    callTool: vi.fn().mockResolvedValue({ content: 'done' }),
  };
}

function jsonRpc(id: string | number | null, method: string, params?: Record<string, unknown>) {
  return { jsonrpc: '2.0', id, method, params };
}

describe('createMcpGateway', () => {
  describe('handleGatewayPost', () => {
    it('rejects unauthenticated requests', async () => {
      const opts = makeOptions();
      opts.resolveAuth.mockRejectedValue(new Error('no token'));
      const gateway = createMcpGateway(opts);
      const res = await gateway.handleGatewayPost({}, jsonRpc(1, 'tools/list'));
      expect(res.status).toBe(401);
      expect((res.body as { error?: { message: string } })?.error?.message).toContain('Unauthorized');
    });

    it('handles initialize', async () => {
      const gateway = createMcpGateway(makeOptions());
      const res = await gateway.handleGatewayPost({}, jsonRpc(1, 'initialize', { protocolVersion: '2025-06-18' }));
      expect(res.status).toBe(200);
      const body = res.body as Record<string, unknown>;
      expect((body as { result?: { protocolVersion?: string } })?.result?.protocolVersion).toBe('2025-06-18');
    });

    it('handles notifications/initialized', async () => {
      const gateway = createMcpGateway(makeOptions());
      const res = await gateway.handleGatewayPost({}, jsonRpc(null, 'notifications/initialized'));
      expect(res.status).toBe(202);
    });

    it('handles tools/list', async () => {
      const gateway = createMcpGateway(makeOptions());
      const res = await gateway.handleGatewayPost({}, jsonRpc(2, 'tools/list'));
      expect(res.status).toBe(200);
      const body = res.body as { result?: { tools?: unknown[] } };
      expect(body.result?.tools).toBeDefined();
      expect(Array.isArray(body.result?.tools)).toBe(true);
    });

    it('handles tools/call for search_tools', async () => {
      const opts = makeOptions();
      const gateway = createMcpGateway(opts);
      const res = await gateway.handleGatewayPost(
        {},
        jsonRpc(3, 'tools/call', { name: 'search_tools', arguments: { query: 'greet', k: 5 } }),
      );
      expect(res.status).toBe(200);
      const body = res.body as { result?: { content?: Array<{ text?: string }> } };
      const contentText = body.result?.content?.[0]?.text ?? '';
      expect(contentText).toContain('greet');
    });

    it('handles tools/call for execute_tool', async () => {
      const opts = makeOptions();
      const gateway = createMcpGateway(opts);
      const res = await gateway.handleGatewayPost(
        {},
        jsonRpc(4, 'tools/call', { name: 'execute_tool', arguments: { server_id: 's1', tool_name: 'greet', args: { name: 'World' } } }),
      );
      expect(res.status).toBe(200);
      expect(opts.callTool).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1' }),
        expect.any(Object),
        'greet',
        { name: 'World' },
      );
    });

    it('returns error for unknown method', async () => {
      const gateway = createMcpGateway(makeOptions());
      const res = await gateway.handleGatewayPost({}, jsonRpc(5, 'resources/list'));
      expect(res.status).toBe(400);
    });

    it('returns error when execute_tool server not found', async () => {
      const opts = makeOptions();
      opts.listVisibleServers.mockResolvedValue([]);
      const gateway = createMcpGateway(opts);
      const res = await gateway.handleGatewayPost(
        {},
        jsonRpc(6, 'tools/call', { name: 'execute_tool', arguments: { server_id: 'nonexistent', tool_name: 'greet' } }),
      );
      expect(res.status).toBe(200); // MCP error response, not HTTP error
      const body = res.body as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
      expect(body.result?.isError).toBe(true);
    });
  });
});