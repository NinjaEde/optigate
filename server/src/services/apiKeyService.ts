import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type {
  ApiKey,
  ApiKeyIdentity,
  AuthContext,
} from '../domain/types.js';
import type { AuditSink } from './registryService.js';
import { NotFoundError } from './errors.js';

export const API_KEY_PREFIX = 'og_';
const SECRET_BYTES = 32;

export interface ApiKeyStore {
  insert(key: ApiKey): Promise<void>;
  findByPrefix(prefix: string): Promise<ApiKey[]>;
  findById(id: string): Promise<ApiKey | null>;
  all(): Promise<ApiKey[]>;
  save(key: ApiKey): Promise<void>;
}

export interface CreateApiKeyInput {
  name: string;
  role: AuthContext['role'];
  tenantId: string | null;
  expiresAt?: string | null;
}

export type ApiKeyResponse = Omit<ApiKey, 'keyHash'>;

/** SHA-256 hex digest — only this leaves the process, never the secret. */
export function hashApiKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Lookup prefix, derivable from the secret alone: og_ + 8 chars of the
 * random part (a leading og_ is stripped first — never doubled).
 */
export function prefixOfSecret(secret: string): string {
  const raw = secret.startsWith(API_KEY_PREFIX)
    ? secret.slice(API_KEY_PREFIX.length)
    : secret;
  return `${API_KEY_PREFIX}${raw.slice(0, 8)}`;
}

/**
 * Prefix as stored before the double-prefix fix (og_og_…): still accepted
 * on verify so already-issued keys keep working.
 *
 * TODO: remove once all pre-fix keys are rotated (or backfill stored
 * prefixes with a one-time UPDATE), plus drop the displayPrefix
 * normalization in web/src/components/ApiKeysView.tsx.
 */
function legacyPrefixOfSecret(secret: string): string {
  return `${API_KEY_PREFIX}${secret.slice(0, 8)}`;
}

function generateSecret(): string {
  return `${API_KEY_PREFIX}${randomBytes(SECRET_BYTES).toString('base64url')}`;
}

function roleRank(role: AuthContext['role']): number {
  return role === 'superadmin' ? 3 : role === 'admin' ? 2 : 1;
}

/**
 * Public shape of a key — explicit field list so the hash (or any future
 * sensitive field) can never leak into responses by accident.
 */
export function toApiKeyResponse(key: ApiKey): ApiKeyResponse {
  return {
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    userId: key.userId,
    role: key.role,
    tenantId: key.tenantId,
    expiresAt: key.expiresAt,
    revokedAt: key.revokedAt,
    createdBy: key.createdBy,
    createdAt: key.createdAt,
  };
}

export class ApiKeyService {
  constructor(
    private readonly store: ApiKeyStore,
    private readonly audit?: AuditSink,
  ) {}

  /**
   * Issues a gateway-only API key. Admins may create keys for their own
   * tenant only and never above their own role; superadmins are
   * unrestricted. API keys themselves can never create keys.
   *
   * Note on roles: on the gateway (/mcp) visibility only distinguishes
   * superadmin (platform-wide) from the rest (tenant-scoped) — an admin
   * key sees exactly what a user key of the same tenant sees. Roles are
   * stored for forward compatibility and audit clarity, not enforcement.
   */
  async createKey(
    auth: AuthContext,
    input: CreateApiKeyInput,
  ): Promise<{ key: ApiKeyResponse; secret: string }> {
    if (auth.viaApiKey) {
      throw new Error('API keys cannot create new API keys');
    }
    if (auth.role === 'user') {
      throw new Error('Only admins may create API keys');
    }
    if (!input.name) {
      throw new Error('Key name is required');
    }
    // Fail closed: an unparseable expiry must never silently mean "forever".
    if (
      input.expiresAt !== undefined
      && input.expiresAt !== null
      && Number.isNaN(Date.parse(input.expiresAt))
    ) {
      throw new Error('expiresAt must be a valid ISO-8601 date');
    }
    if (roleRank(input.role) > roleRank(auth.role)) {
      throw new Error('Key role must not exceed your own role');
    }
    if (auth.role === 'admin') {
      if (!auth.tenantId || input.tenantId !== auth.tenantId) {
        throw new Error('Admins may only create keys for their own tenant');
      }
    }

    const secret = generateSecret();
    const now = new Date().toISOString();
    const key: ApiKey = {
      id: crypto.randomUUID(),
      name: input.name,
      keyPrefix: prefixOfSecret(secret),
      keyHash: hashApiKey(secret),
      userId: auth.userId,
      role: input.role,
      tenantId: input.tenantId,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdBy: auth.userId,
      createdAt: now,
    };

    await this.store.insert(key);
    await this.audit?.record({
      actorId: auth.userId,
      tenantId: key.tenantId,
      action: 'apikey.created',
      subjectId: key.id,
      detail: { name: key.name, role: key.role },
    });

    return { key: toApiKeyResponse(key), secret };
  }

  /** Resolves a presented secret to an identity, or null when invalid. */
  async verifyKey(secret: string): Promise<ApiKeyIdentity | null> {
    if (!secret) {
      return null;
    }
    // Legacy fallback: keys issued before the double-prefix fix are stored
    // under legacyPrefixOfSecret. Candidates are always hash-checked below,
    // so the wider lookup cannot grant access by itself.
    const prefixes = [prefixOfSecret(secret)];
    const legacy = legacyPrefixOfSecret(secret);
    if (legacy !== prefixes[0]) {
      prefixes.push(legacy);
    }
    const candidates = (
      await Promise.all(prefixes.map((p) => this.store.findByPrefix(p)))
    ).flat();
    const presented = Buffer.from(hashApiKey(secret), 'hex');
    const now = new Date();

    for (const key of candidates) {
      const stored = Buffer.from(key.keyHash, 'hex');
      if (stored.length !== presented.length) {
        continue;
      }
      if (!timingSafeEqual(stored, presented)) {
        continue;
      }
      if (key.revokedAt) {
        return null;
      }
      if (key.expiresAt && new Date(key.expiresAt) <= now) {
        return null;
      }
      return {
        keyId: key.id,
        userId: key.userId,
        role: key.role,
        tenantId: key.tenantId,
      };
    }
    return null;
  }

  async listKeys(auth: AuthContext): Promise<ApiKeyResponse[]> {
    if (auth.viaApiKey || auth.role === 'user') {
      throw new Error('Only admins may list API keys');
    }
    const all = await this.store.all();
    const visible =
      auth.role === 'superadmin'
        ? all
        : all.filter((k) => k.tenantId !== null && k.tenantId === auth.tenantId);
    return visible.map(toApiKeyResponse);
  }

  async revokeKey(auth: AuthContext, id: string): Promise<ApiKeyResponse> {
    if (auth.viaApiKey || auth.role === 'user') {
      throw new Error('Only admins may revoke API keys');
    }
    const key = await this.store.findById(id);
    if (!key) {
      throw new NotFoundError('API key not found');
    }
    if (
      auth.role === 'admin'
      && (key.tenantId === null || key.tenantId !== auth.tenantId)
    ) {
      throw new Error('Admins may only revoke keys of their own tenant');
    }

    key.revokedAt = new Date().toISOString();
    await this.store.save(key);
    await this.audit?.record({
      actorId: auth.userId,
      tenantId: key.tenantId,
      action: 'apikey.revoked',
      subjectId: key.id,
      detail: { name: key.name },
    });

    return toApiKeyResponse(key);
  }
}
