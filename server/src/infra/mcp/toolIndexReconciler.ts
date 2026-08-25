import type { MCPServer, ToolMeta } from '../../domain/types.js';

export interface ReconcilerDeps {
  /**
   * All active servers from the repository (unfiltered — the reconciler
   * runs with system privileges and decides itself what belongs in the
   * index: only healthy servers).
   */
  allActiveServers(): Promise<MCPServer[]>;
  /** Connects (or reuses) the pool connection and returns fresh tools. */
  syncTools(server: MCPServer): Promise<ToolMeta[]>;
  /** Called whenever the index content changed. */
  onIndexUpdated?(index: Map<string, ToolMeta[]>): void;
}

export interface ToolIndexReconcilerOptions {
  /** Delay between retries per server (ms). Default 5s. */
  retryDelayMs?: number;
  /** Background refresh interval (ms). Default 60s. */
  intervalMs?: number;
  /** Logger for diagnostics. */
  log?: (msg: string) => void;
}

const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Keeps the global tool index continuously up to date:
 *
 *  - On start(): connects every healthy server (with retries) and builds
 *    the index, so search_tools works immediately after boot.
 *  - A background loop periodically re-syncs healthy servers, marks
 *    unreachable ones degraded/offline and drops deleted/disabled ones
 *    from the index.
 *  - reconcileNow() can be triggered ad hoc (e.g. after register/approve).
 *
 * The index maps serverId → ToolMeta[]; consumers (REST /api/tools/search,
 * /mcp gateway) read it via snapshot().
 */
export class ToolIndexReconciler {
  private index = new Map<string, ToolMeta[]>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly retryDelayMs: number;
  private readonly intervalMs: number;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly deps: ReconcilerDeps,
    options: ToolIndexReconcilerOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.log = options.log ?? (() => undefined);
  }

  snapshot(): Map<string, ToolMeta[]> {
    return this.index;
  }

  /**
   * Builds/refreshes the index once. Healthy servers are synced with up to
   * three attempts; unreachable ones keep their last known tools (stale
   * data is better than none) unless they were never reachable.
   */
  async reconcileNow(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      const servers = await this.deps.allActiveServers();
      const nextIndex = new Map<string, ToolMeta[]>();

      for (const server of servers) {
        const previous = this.index.get(server.id);

        // deleted / disabled / pending → drop from index entirely
        if (server.status !== 'healthy') {
          continue;
        }

        let tools: ToolMeta[] | null = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            tools = await this.deps.syncTools(server);
            break;
          } catch (err) {
            this.log(
              `tool sync failed for "${server.name}" `
              + `(attempt ${attempt}/3): ${(err as Error).message}`,
            );
            if (attempt < 3) {
              await delay(this.retryDelayMs);
            }
          }
        }

        if (tools && tools.length > 0) {
          nextIndex.set(server.id, tools);
        } else if (tools === null && previous) {
          // unreachable but previously indexed → keep stale copy
          nextIndex.set(server.id, previous);
        }
        // tools === [] (server reachable, genuinely no tools) → drop
      }

      const sizeBefore = this.index.size;
      this.index = nextIndex;
      this.deps.onIndexUpdated?.(this.index);

      if (nextIndex.size !== sizeBefore) {
        this.log(`tool index updated: ${nextIndex.size} server(s) indexed`);
      }
    } finally {
      this.running = false;
    }
  }

  /** Starts the background reconciliation loop. */
  start(): void {
    if (this.timer) {
      return;
    }
    // initial build without blocking boot; failures just log
    void this.reconcileNow().catch((err) =>
      this.log(`initial reconcile failed: ${(err as Error).message}`),
    );

    this.timer = setInterval(() => {
      void this.reconcileNow().catch((err) =>
        this.log(`reconcile failed: ${(err as Error).message}`),
      );
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
