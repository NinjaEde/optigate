import { describe, it, expect, vi } from 'vitest';
import { ToolIndexReconciler } from '../../src/infra/mcp/toolIndexReconciler.js';
import type { MCPServer, ToolMeta } from '../../src/domain/types.js';

function makeServer(id: string, status: MCPServer['status'] = 'healthy'): MCPServer {
  return {
    id,
    tenantId: null,
    name: `srv-${id}`,
    description: '',
    scope: 'global',
    ownerId: null,
    transport: 'streamable_http',
    connection: { url: `https://${id}.example.com/mcp` },
    status,
    createdBy: 'test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  } as MCPServer;
}

function makeTool(name: string, serverId = 's1'): ToolMeta {
  return {
    serverId,
    name,
    description: `tool ${name}`,
    inputSchema: {},
    lastSeenAt: new Date().toISOString(),
  };
}

describe('ToolIndexReconciler', () => {
  let logs: string[];
  let index: Map<string, ToolMeta[]>;
  let markStatusCalls: Array<{ id: string; status: string; detail: string }>;

  function makeDeps(servers: MCPServer[], syncSuccess = true) {
    logs = [];
    index = new Map();
    markStatusCalls = [];

    return {
      allActiveServers: vi.fn().mockResolvedValue(servers),
      syncTools: vi.fn().mockImplementation(async () => {
        if (!syncSuccess) {
          throw new Error('connection refused');
        }
        return [makeTool('tool-a'), makeTool('tool-b')];
      }),
      onIndexUpdated: vi.fn().mockImplementation((newIndex: Map<string, ToolMeta[]>) => {
        index = new Map(newIndex);
      }),
      markStatus: vi.fn().mockImplementation(
        async (id: string, status: string, detail: string) => {
          markStatusCalls.push({ id, status, detail });
        },
      ),
      log: (msg: string) => logs.push(msg),
    };
  }

  it('indexes healthy servers on reconcile', async () => {
    const deps = makeDeps([makeServer('s1')]);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });
    await reconciler.reconcileNow();

    expect(index.size).toBe(1);
    expect(index.get('s1')).toHaveLength(2);
  });

  it('skips non-healthy servers', async () => {
    const deps = makeDeps([
      makeServer('s1', 'healthy'),
      makeServer('s2', 'pending_approval'),
      makeServer('s3', 'disabled'),
    ]);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });
    await reconciler.reconcileNow();

    expect(index.size).toBe(1);
    expect(index.has('s2')).toBe(false);
    expect(index.has('s3')).toBe(false);
  });

  it('keeps stale tools when sync fails and previous data exists', async () => {
    const deps = makeDeps([makeServer('s1')], false);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });

    // seed with previous data
    const seed = new Map([['s1', [makeTool('tool-c')]]]);
    (reconciler as unknown as { index: Map<string, ToolMeta[]> }).index = seed;

    await reconciler.reconcileNow();

    // stale copy kept
    expect(index.get('s1')).toHaveLength(1);
    expect(index.get('s1')![0].name).toBe('tool-c');
  });

  it('drops server when sync fails and no previous data', async () => {
    const deps = makeDeps([makeServer('s1')], false);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });
    await reconciler.reconcileNow();

    expect(index.size).toBe(0);
  });

  it('sets degraded after 2 consecutive failures', async () => {
    const deps = makeDeps([makeServer('s1')], false);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });

    // seed with previous so the reconciler doesn't just drop
    const seed = new Map([['s1', [makeTool('tool-c')]]]);
    (reconciler as unknown as { index: Map<string, ToolMeta[]> }).index = seed;

    await reconciler.reconcileNow();
    await reconciler.reconcileNow();

    // after 2 failures, markStatus should have been called with 'degraded'
    const degradedCall = markStatusCalls.find((c) => c.status === 'degraded');
    expect(degradedCall).toBeDefined();
    expect(degradedCall!.id).toBe('s1');
  });

  it('resets failure count on successful sync and restores healthy', async () => {
    let succeeded = false;
    const servers = [makeServer('s1')];
    const markCalls: Array<{ id: string; status: string; detail: string }> = [];
    const deps = {
      allActiveServers: vi.fn().mockResolvedValue(servers),
      syncTools: vi.fn().mockImplementation(async () => {
        if (!succeeded) {
          throw new Error('fail');
        }
        return [makeTool('tool-a')];
      }),
      onIndexUpdated: vi.fn(),
      markStatus: vi.fn().mockImplementation(
        async (id: string, status: string, detail: string) => {
          markCalls.push({ id, status, detail });
        },
      ),
      log: (msg: string) => logs.push(msg),
    };

    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });
    const seed = new Map([['s1', [makeTool('tool-c')]]]);
    (reconciler as unknown as { index: Map<string, ToolMeta[]> }).index = seed;

    // first 2 reconciles fail
    await reconciler.reconcileNow();
    await reconciler.reconcileNow();

    // mark succeeds on 3rd
    succeeded = true;
    await reconciler.reconcileNow();

    const healthyCall = markCalls.find((c) => c.status === 'healthy');
    expect(healthyCall).toBeDefined();
    expect(healthyCall!.detail).toBe('reconnected');
  });

  it('survives markStatus bookkeeping failures (e.g. DB blip)', async () => {
    const deps = makeDeps([makeServer('s1')], false);
    deps.markStatus = vi.fn().mockRejectedValue(new Error('db down'));
    // note: the class reads its logger from options, not deps
    const logged: string[] = [];
    const reconciler = new ToolIndexReconciler(deps, {
      retryDelayMs: 1,
      log: (msg: string) => logged.push(msg),
    });

    // must resolve (not throw / crash on unhandled rejection) and log
    await reconciler.reconcileNow();
    await reconciler.reconcileNow();
    expect(logged.some((m) => m.includes('markStatus failed'))).toBe(true);
  });

  it('coalesces concurrent reconcileNow calls instead of dropping them', async () => {
    let runs = 0;
    const deps = makeDeps([makeServer('s1')]);
    const gated = { release: () => undefined as void };
    const gate = new Promise<void>((resolve) => {
      gated.release = resolve;
    });
    deps.syncTools = vi.fn().mockImplementation(async () => {
      runs++;
      if (runs === 1) {
        await gate;
      }
      return [makeTool('tool-a')];
    });
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });

    const first = reconciler.reconcileNow();
    // arrives while the first pass is gated → must trigger a second pass
    const second = reconciler.reconcileNow();
    gated.release();
    await Promise.all([first, second]);

    expect(runs).toBe(2);
    expect(index.get('s1')?.map((t) => t.name)).toEqual(['tool-a']);
  });

  it('drops stale tools after maxStaleCycles', async () => {
    const deps = makeDeps([makeServer('s1')], false);
    const logged: string[] = [];
    const reconciler = new ToolIndexReconciler(deps, {
      retryDelayMs: 1,
      maxStaleCycles: 1,
      log: (msg: string) => logged.push(msg),
    });
    const seed = new Map([['s1', [makeTool('tool-c')]]]);
    (reconciler as unknown as { index: Map<string, ToolMeta[]> }).index = seed;

    await reconciler.reconcileNow();
    expect(index.get('s1')?.map((t) => t.name)).toEqual(['tool-c']);

    await reconciler.reconcileNow();
    expect(index.has('s1')).toBe(false);
    expect(logged.some((m) => m.includes('dropping stale tools'))).toBe(true);
  });

  it('stop() waits for an in-flight pass', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = makeDeps([makeServer('s1')]);
    deps.syncTools = vi.fn().mockImplementation(async () => {
      await gate;
      return [makeTool('tool-a')];
    });
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });

    const run = reconciler.reconcileNow();
    const stopped = reconciler.stop().then(() => 'stopped');
    // stop must not resolve while the pass is gated
    const early = await Promise.race([
      stopped,
      Promise.resolve('still-running'),
    ]);
    expect(early).toBe('still-running');

    release();
    await run;
    expect(await stopped).toBe('stopped');
    expect(index.get('s1')?.map((t) => t.name)).toEqual(['tool-a']);
  });

  it('provides snapshot of current index', () => {
    const deps = makeDeps([]);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });
    expect(reconciler.snapshot()).toBeInstanceOf(Map);
  });

  it('start() triggers initial reconcile and sets up timer', async () => {
    const deps = makeDeps([makeServer('s1')]);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1, intervalMs: 1000 });
    reconciler.start();

    // wait for initial reconcile
    await new Promise((r) => setTimeout(r, 50));

    expect(index.size).toBe(1);
    reconciler.stop();
  });

  it('stop() clears the timer', () => {
    const deps = makeDeps([]);
    const reconciler = new ToolIndexReconciler(deps, { intervalMs: 100 });
    reconciler.start();
    reconciler.stop();
    // calling stop again is safe
    reconciler.stop();
  });

  it('reconcileNow coalesces concurrent calls into one extra pass', async () => {
    const deps = makeDeps([makeServer('s1')]);
    const reconciler = new ToolIndexReconciler(deps, { retryDelayMs: 1 });

    // start several in parallel — triggers collapse into a single rerun
    await Promise.all([
      reconciler.reconcileNow(),
      reconciler.reconcileNow(),
      reconciler.reconcileNow(),
    ]);

    // initial pass + exactly one coalesced pass (no lost work, no stampede)
    expect(deps.syncTools).toHaveBeenCalledTimes(2);
  });
});