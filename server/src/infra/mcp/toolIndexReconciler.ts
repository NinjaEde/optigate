import type { MCPServer, ServerStatus, ToolMeta } from '../../domain/types.js';

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
  /**
   * Reports a server status change back to the registry.
   * Used to set 'degraded' after repeated failures or back to 'healthy'
   * on success.
   */
  markStatus?(serverId: string, status: ServerStatus, detail: string): Promise<void>;
}

export interface ToolIndexReconcilerOptions {
  /** Delay between retries per server (ms). Default 5s. */
  retryDelayMs?: number;
  /** Background refresh interval (ms). Default 60s. */
  intervalMs?: number;
  /**
   * Jitter max fraction of interval to add randomly (0–1).
   * Default 0.2 (so the actual interval varies ±20% around intervalMs).
   */
  jitter?: number;
  /** Logger for diagnostics. */
  log?: (msg: string) => void;
}

const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_JITTER = 0.2;

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
  private readonly jitter: number;
  private readonly log: (msg: string) => void;
  /** Track consecutive failures per server to set degraded status. */
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    private readonly deps: ReconcilerDeps,
    options: ToolIndexReconcilerOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.jitter = options.jitter ?? DEFAULT_JITTER;
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
        if (server.status !== 'healthy' && server.status !== 'degraded') {
          continue;
        }

        let tools: ToolMeta[] | null = null;
        let succeeded = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            tools = await this.deps.syncTools(server);
            succeeded = true;
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

        if (succeeded) {
          // had consecutive failures before → restore to healthy
          const hadFailures = this.consecutiveFailures.delete(server.id);
          if (hadFailures && this.deps.markStatus) {
            void this.deps.markStatus(server.id, 'healthy', 'reconnected');
          }
        } else {
          // increment consecutive failure counter
          const failures = (this.consecutiveFailures.get(server.id) ?? 0) + 1;
          this.consecutiveFailures.set(server.id, failures);

          // after 2 consecutive failures → set degraded
          if (failures >= 2 && this.deps.markStatus) {
            void this.deps.markStatus(server.id, 'degraded', `${failures} consecutive sync failures`);
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

    const scheduleNext = () => {
      const jitterMs = Math.random() * this.intervalMs * this.jitter;
      const delayMs = this.intervalMs - (this.intervalMs * this.jitter) / 2 + jitterMs;
      this.timer = setTimeout(() => {
        void this.reconcileNow().catch((err) =>
          this.log(`reconcile failed: ${(err as Error).message}`),
        ).finally(() => {
          scheduleNext();
        });
      }, delayMs);
      this.timer.unref();
    };

    scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}