import { describe, it, expect, vi } from 'vitest';
import { createMcpGateway } from '../../src/infra/mcp/gateway.js';
import { DecisionOutputError } from '../../src/domain/toolDecision.js';

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

  describe('search_tools decision mode', () => {
    type GatewayOptions = Parameters<typeof createMcpGateway>[0];

    /** Pool-style retrieval: returns all tools regardless of the query. */
    function makeDecisionOptions(
      resolveDecision?: () => Promise<{ model: unknown; candidatePool: number } | null>,
    ): GatewayOptions {
      const opts = makeOptions() as unknown as GatewayOptions & Record<string, unknown>;
      opts.searchTools = vi.fn().mockImplementation(
        (tools: unknown[], _query: string, limit: number) =>
          (tools as Array<{ name: string }>).slice(0, limit).map((t) => ({ ...t, score: 1 })),
      );
      if (resolveDecision !== undefined) {
        opts.resolveDecision = resolveDecision as GatewayOptions['resolveDecision'];
      }
      return opts as GatewayOptions;
    }

    async function callSearch(opts: GatewayOptions, mode: 'lexical' | 'decision') {
      const gateway = createMcpGateway(opts);
      const res = await gateway.handleGatewayPost(
        {},
        jsonRpc(10, 'tools/call', {
          name: 'search_tools',
          arguments: { query: 'anything', k: 5, mode },
        }),
      );
      expect(res.status).toBe(200);
      const body = res.body as { result?: { content?: Array<{ text?: string }> } };
      const blocks = (body.result?.content ?? []).map((c) => JSON.parse(c.text ?? 'null'));
      return { results: blocks[0], meta: blocks[1] } as {
        results: Array<{ tool: string; score: number; lexicalScore?: number }>;
        meta?: Record<string, unknown>;
      };
    }

    it('reranks the lexical candidate pool and reports metadata', async () => {
      const select = vi.fn().mockResolvedValue({
        outcome: {
          kind: 'ranking',
          scores: [
            { key: 's1::echo', score: 0.9 },
            { key: 's1::greet', score: 0.4 },
          ],
        },
      });
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({ model: { provider: 'fake', select }, candidatePool: 5 });

      const { results, meta } = await callSearch(opts, 'decision');

      expect(results.map((r) => r.tool)).toEqual(['echo', 'greet']);
      expect(results[0].score).toBe(0.9);
      expect(results[0].lexicalScore).toBe(1);
      expect(meta).toMatchObject({ used: true, provider: 'fake', none: false, fallback: null });
      expect(select).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'anything', limit: 5 }),
      );
    });

    it('fills remainder slots from lexical order', async () => {
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({
        model: {
          provider: 'fake',
          select: vi.fn().mockResolvedValue({
            outcome: { kind: 'ranking', scores: [{ key: 's1::echo', score: 0.8 }] },
          }),
        },
        candidatePool: 5,
      });

      const { results } = await callSearch(opts, 'decision');
      // echo ranked by the model, greet filled from lexical order
      expect(results.map((r) => r.tool)).toEqual(['echo', 'greet']);
      expect(results[1].score).toBe(1); // untouched lexical score
      expect(results[1].lexicalScore).toBeUndefined();
    });

    it('returns an empty result when the model says none', async () => {
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({
        model: {
          provider: 'fake',
          select: vi.fn().mockResolvedValue({
            outcome: { kind: 'none', confidence: 0.85 },
          }),
        },
        candidatePool: 5,
      });

      const { results, meta } = await callSearch(opts, 'decision');
      expect(results).toEqual([]);
      expect(meta).toMatchObject({ used: true, none: true, confidence: 0.85 });
    });

    it('falls back to lexical results on model errors', async () => {
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({
        model: {
          provider: 'fake',
          select: vi.fn().mockRejectedValue(new Error('boom')),
        },
        candidatePool: 5,
      });

      const { results, meta } = await callSearch(opts, 'decision');
      expect(results.map((r) => r.tool)).toEqual(['greet', 'echo']);
      expect(meta).toMatchObject({ used: false, fallback: 'error', error: 'boom' });
    });

    it('distinguishes invalid model output from transport errors', async () => {
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({
        model: {
          provider: 'fake',
          select: vi.fn().mockRejectedValue(new DecisionOutputError('bad json')),
        },
        candidatePool: 5,
      });

      const { meta } = await callSearch(opts, 'decision');
      expect(meta).toMatchObject({ used: false, fallback: 'invalid_output' });
    });

    it('falls back with disabled metadata when no model is configured', async () => {
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => null;

      const { results, meta } = await callSearch(opts, 'decision');
      expect(results.map((r) => r.tool)).toEqual(['greet', 'echo']);
      expect(meta).toMatchObject({ used: false, fallback: 'disabled' });
    });

    it('returns a no_candidates marker when retrieval is empty', async () => {
      const opts = makeDecisionOptions();
      opts.buildToolIndex = vi.fn().mockResolvedValue([]);
      opts.resolveDecision = async () => ({
        model: {
          provider: 'fake',
          select: vi.fn().mockRejectedValue(new Error('must not be called')),
        },
        candidatePool: 5,
      });

      const { results, meta } = await callSearch(opts, 'decision');
      expect(results).toEqual([]);
      expect(meta).toMatchObject({ used: false, fallback: 'no_candidates' });
    });

    it('keeps lexical mode untouched when mode is not decision', async () => {
      const select = vi.fn();
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({
        model: { provider: 'fake', select },
        candidatePool: 5,
      });

      const { results, meta } = await callSearch(opts, 'lexical');
      // single content block, no decision metadata, model never called
      expect(results.map((r) => r.tool)).toEqual(['greet', 'echo']);
      expect(meta).toBeUndefined();
      expect(select).not.toHaveBeenCalled();
    });

    it('forces reranking for lexical requests when decisionForce is set', async () => {
      const select = vi.fn().mockResolvedValue({
        outcome: {
          kind: 'ranking',
          scores: [{ key: 's1::echo', score: 0.9 }],
        },
      });
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => ({
        model: { provider: 'fake', select },
        candidatePool: 5,
      });
      opts.decisionForce = () => true;

      const { results, meta } = await callSearch(opts, 'lexical');
      expect(results.map((r) => r.tool)).toEqual(['echo', 'greet']);
      expect(meta).toMatchObject({ used: true, provider: 'fake', forced: true });
      expect(select).toHaveBeenCalled();

      // explicit decision mode is not marked as forced
      const explicit = await callSearch(opts, 'decision');
      expect(explicit.meta).toMatchObject({ used: true });
      expect(explicit.meta?.forced).toBeUndefined();
    });

    it('supports a static boolean decisionForce', async () => {
      const opts = makeDecisionOptions();
      opts.resolveDecision = async () => null;
      opts.decisionForce = true;

      const { meta } = await callSearch(opts, 'lexical');
      expect(meta).toMatchObject({ used: false, fallback: 'disabled', forced: true });
    });
  });
});