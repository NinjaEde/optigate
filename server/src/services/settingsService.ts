import type { AuthContext } from '../domain/types.js';
import type { AuditSink } from './registryService.js';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js';

export type SettingType = 'string' | 'number' | 'boolean';
export type SettingSource = 'db' | 'env' | 'default';

export interface SettingDef {
  key: string;
  type: SettingType;
  default: string | number | boolean;
  /** Boot baseline from the environment; a DB row always wins. */
  env?: string;
  /** Minimum role allowed to change the value at runtime. */
  minRole: 'superadmin' | 'admin';
  min?: number;
  max?: number;
  description: string;
}

/**
 * Runtime-tunable operational settings. Precedence: DB row > env var >
 * built-in default. Only tuning knobs live here — validation shapes,
 * crypto parameters and auth logic stay hardcoded on purpose.
 */
export const SETTING_DEFS: SettingDef[] = [
  {
    key: 'ratelimit.max',
    type: 'number',
    default: 200,
    env: 'RATE_LIMIT_MAX',
    minRole: 'admin',
    min: 1,
    max: 100000,
    description: 'Max requests per minute (global rate limit).',
  },
  {
    key: 'reconciler.intervalMs',
    type: 'number',
    default: 60000,
    env: 'RECONCILE_INTERVAL_MS',
    minRole: 'admin',
    min: 5000,
    max: 3600000,
    description: 'Tool index refresh interval in milliseconds.',
  },
  {
    key: 'reconciler.retryDelayMs',
    type: 'number',
    default: 5000,
    env: 'RECONCILE_RETRY_MS',
    minRole: 'admin',
    min: 100,
    max: 60000,
    description: 'Delay between per-server sync retries in milliseconds.',
  },
  {
    key: 'reconciler.maxStaleCycles',
    type: 'number',
    default: 10,
    env: 'RECONCILE_MAX_STALE',
    minRole: 'admin',
    min: 0,
    max: 1000,
    description: 'Cycles unreachable servers keep stale tools before drop.',
  },
  {
    key: 'search.defaultLimit',
    type: 'number',
    default: 5,
    env: 'SEARCH_DEFAULT_LIMIT',
    minRole: 'admin',
    min: 1,
    max: 50,
    description: 'Default top-k for tool retrieval.',
  },
  {
    key: 'search.maxLimit',
    type: 'number',
    default: 20,
    env: 'SEARCH_MAX_LIMIT',
    minRole: 'admin',
    min: 1,
    max: 50,
    description: 'Maximum top-k any client may request.',
  },
  {
    key: 'audit.limit',
    type: 'number',
    default: 100,
    env: 'AUDIT_LIMIT',
    minRole: 'admin',
    min: 1,
    max: 1000,
    description: 'Max events returned by the audit feed.',
  },
  {
    key: 'pool.maxConnsPerServer',
    type: 'number',
    default: 20,
    env: 'MAX_CONNS_PER_SERVER',
    minRole: 'admin',
    min: 1,
    max: 200,
    description: 'Max simultaneous upstream connections per server.',
  },
  {
    key: 'gateway.dispatchTimeoutMs',
    type: 'number',
    default: 30000,
    env: 'GATEWAY_DISPATCH_TIMEOUT_MS',
    minRole: 'admin',
    min: 1000,
    max: 300000,
    description: 'Timeout per /mcp JSON-RPC dispatch in milliseconds.',
  },
  {
    key: 'registry.approvalRequired',
    type: 'boolean',
    default: true,
    env: 'APPROVAL_REQUIRED',
    minRole: 'superadmin',
    description: 'New servers start as pending_approval (supply-chain gate).',
  },
  {
    key: 'ssrf.allowedHosts',
    type: 'string',
    default: '',
    env: 'SSRF_ALLOWED_HOSTS',
    minRole: 'superadmin',
    description:
      'Comma-separated allowed upstream hosts (*. globs). Empty = allow all routable targets.',
  },
  {
    key: 'ssrf.allowPrivateRanges',
    type: 'boolean',
    default: false,
    env: 'SSRF_ALLOW_PRIVATE_RANGES',
    minRole: 'superadmin',
    description:
      'Also allow loopback/private/link-local targets. Home-lab only: exposes internal networks to registered servers.',
  },
];

const DEFS = new Map(SETTING_DEFS.map((d) => [d.key, d]));

export interface SettingsStore {
  /** Stored DB override, or undefined when falling back to env/default. */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, updatedBy: string): Promise<void>;
  delete(key: string): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

export interface SettingView {
  key: string;
  type: SettingType;
  value: string | number | boolean;
  source: SettingSource;
  minRole: 'superadmin' | 'admin';
  min?: number;
  max?: number;
  description: string;
}

function parseEnv(def: SettingDef, raw: string | undefined):
  | { found: true; value: string | number | boolean }
  | { found: false } {
  if (raw === undefined || raw === '') {
    return { found: false };
  }
  if (def.type === 'boolean') {
    return { found: true, value: ['true', '1', 'yes'].includes(raw.toLowerCase()) };
  }
  if (def.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { found: false };
    }
    return { found: true, value: n };
  }
  return { found: true, value: raw };
}

/** Staleness window for the in-memory mirror (tuning knobs only). */
const CACHE_TTL_MS = 5_000;

export class SettingsService {
  private readonly cache = new Map<string, { value: unknown; at: number }>();

  constructor(
    private readonly store: SettingsStore,
    private readonly audit?: AuditSink,
  ) {}

  def(key: string): SettingDef {
    const def = DEFS.get(key);
    if (!def) {
      throw new NotFoundError(`Unknown setting "${key}"`);
    }
    return def;
  }

  /** Effective value: DB override > env var > built-in default. */
  async get<T extends string | number | boolean>(key: string): Promise<T> {
    const def = this.def(key);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) {
      return hit.value as T;
    }
    const stored = await this.store.get(key);
    let effective: unknown;
    if (stored !== undefined) {
      effective = stored;
    } else {
      const fromEnv = parseEnv(def, process.env[def.env ?? '']);
      effective = fromEnv.found ? fromEnv.value : def.default;
    }
    this.cache.set(key, { value: effective, at: now });
    return effective as T;
  }

  /**
   * Sync read of the last-known effective value for hot paths
   * (rate limiting, per-request limits). Boot-loaded and kept fresh by
   * write-through on set()/reset(); falls back to env/default when cold.
   */
  getCached<T extends string | number | boolean>(key: string): T {
    const def = this.def(key);
    const hit = this.cache.get(key);
    if (hit) {
      return hit.value as T;
    }
    const fromEnv = parseEnv(def, process.env[def.env ?? '']);
    return (fromEnv.found ? fromEnv.value : def.default) as T;
  }

  /** Best-effort preload at boot (DB may be unreachable — cold path covers). */
  async refresh(): Promise<void> {
    for (const def of SETTING_DEFS) {
      try {
        await this.get(def.key);
      } catch {
        // cold env/default fallback stays in place
      }
    }
  }

  async list(): Promise<SettingView[]> {
    const stored = await this.store.all();
    return SETTING_DEFS.map((def) => {
      if (stored[def.key] !== undefined) {
        return this.view(def, stored[def.key], 'db');
      }
      const fromEnv = parseEnv(def, process.env[def.env ?? '']);
      if (fromEnv.found) {
        return this.view(def, fromEnv.value, 'env');
      }
      return this.view(def, def.default, 'default');
    });
  }

  async set(
    auth: AuthContext,
    key: string,
    value: unknown,
  ): Promise<SettingView> {
    const def = this.def(key);
    this.assertMayWrite(auth, def);
    const checked = this.checkValue(def, value);
    await this.store.set(key, checked, auth.userId);
    this.cache.set(key, { value: checked, at: Date.now() });
    await this.audit?.record({
      actorId: auth.userId,
      tenantId: auth.tenantId,
      action: 'setting.changed',
      subjectId: key,
      detail: { value: checked },
    });
    return this.view(def, checked, 'db');
  }

  /** Deletes the DB override — the value falls back to env/default. */
  async reset(auth: AuthContext, key: string): Promise<SettingView> {
    const def = this.def(key);
    this.assertMayWrite(auth, def);
    await this.store.delete(key);
    this.cache.delete(key);
    await this.audit?.record({
      actorId: auth.userId,
      tenantId: auth.tenantId,
      action: 'setting.changed',
      subjectId: key,
      detail: { reset: true },
    });
    const fromEnv = parseEnv(def, process.env[def.env ?? '']);
    return fromEnv.found
      ? this.view(def, fromEnv.value, 'env')
      : this.view(def, def.default, 'default');
  }

  private assertMayWrite(auth: AuthContext, def: SettingDef): void {
    if (auth.viaApiKey) {
      throw new ForbiddenError('API keys cannot change settings');
    }
    if (def.minRole === 'superadmin' && auth.role !== 'superadmin') {
      throw new ForbiddenError(`Only superadmins may change "${def.key}"`);
    }
    if (auth.role !== 'superadmin' && auth.role !== 'admin') {
      throw new ForbiddenError('Only admins may change settings');
    }
  }

  private checkValue(
    def: SettingDef,
    value: unknown,
  ): string | number | boolean {
    if (def.type === 'string') {
      if (typeof value !== 'string') {
        throw new ValidationError(`Setting "${def.key}" must be a string`);
      }
      return value;
    }
    if (def.type === 'boolean') {
      if (typeof value !== 'boolean') {
        throw new ValidationError(`Setting "${def.key}" must be a boolean`);
      }
      return value;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ValidationError(`Setting "${def.key}" must be a finite number`);
    }
    if (def.min !== undefined && value < def.min) {
      throw new ValidationError(`Setting "${def.key}" must be >= ${def.min}`);
    }
    if (def.max !== undefined && value > def.max) {
      throw new ValidationError(`Setting "${def.key}" must be <= ${def.max}`);
    }
    return value;
  }

  private view(
    def: SettingDef,
    value: string | number | boolean | unknown,
    source: SettingSource,
  ): SettingView {
    return {
      key: def.key,
      type: def.type,
      value: value as string | number | boolean,
      source,
      minRole: def.minRole,
      ...(def.min !== undefined ? { min: def.min } : {}),
      ...(def.max !== undefined ? { max: def.max } : {}),
      description: def.description,
    };
  }
}
