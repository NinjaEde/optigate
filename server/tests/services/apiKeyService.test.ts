import { describe, it, expect, beforeEach } from 'vitest';

import { InMemoryApiKeyStore } from '../../src/infra/repositories/memoryApiKeyStore';
import {
  ApiKeyService,
  hashApiKey,
  prefixOfSecret,
} from '../../src/services/apiKeyService';
import { NotFoundError } from '../../src/services/errors';
import type { ApiKey } from '../../src/domain/types';
import type { AuthContext } from '../../src/domain/types';

const SUPER: AuthContext = { userId: 'u0', role: 'superadmin', tenantId: null };
const ADMIN: AuthContext = { userId: 'u1', role: 'admin', tenantId: 't1' };
const USER: AuthContext = { userId: 'u2', role: 'user', tenantId: 't1' };

function makeService(): ApiKeyService {
  return new ApiKeyService(new InMemoryApiKeyStore());
}

describe('ApiKeyService', () => {
  let svc: ApiKeyService;

  beforeEach(() => {
    svc = makeService();
  });

  it('creates a verifiable key; hash stored, secret never persisted', async () => {
    const { key, secret } = await svc.createKey(ADMIN, {
      name: 'agent',
      role: 'user',
      tenantId: 't1',
    });

    expect(secret.startsWith('og_')).toBe(true);
    expect(key.keyPrefix).toBe(prefixOfSecret(secret));
    expect(key).not.toHaveProperty('keyHash');

    const identity = await svc.verifyKey(secret);
    expect(identity).toMatchObject({
      userId: 'u1',
      role: 'user',
      tenantId: 't1',
    });

    // the stored record holds only the hash
    const stored = await svc.listKeys(SUPER);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(secret.slice(3));
    expect(hashApiKey(secret)).toHaveLength(64);
  });

  it('rejects unknown secrets', async () => {
    expect(await svc.verifyKey('og_nope-nope-nope')).toBeNull();
    expect(await svc.verifyKey('')).toBeNull();
  });

  it('rejects expired and revoked keys', async () => {
    const expired = await svc.createKey(ADMIN, {
      name: 'old',
      role: 'user',
      tenantId: 't1',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await svc.verifyKey(expired.secret)).toBeNull();

    const live = await svc.createKey(ADMIN, {
      name: 'live',
      role: 'user',
      tenantId: 't1',
    });
    expect(await svc.verifyKey(live.secret)).not.toBeNull();
    await svc.revokeKey(ADMIN, live.key.id);
    expect(await svc.verifyKey(live.secret)).toBeNull();
  });

  it('rejects unparseable expiresAt instead of defaulting to forever', async () => {
    await expect(
      svc.createKey(ADMIN, {
        name: 'bogus-expiry',
        role: 'user',
        tenantId: 't1',
        expiresAt: 'gestern',
      }),
    ).rejects.toThrow(/ISO-8601/i);
  });

  it('enforces role cap and tenant scope on creation', async () => {
    await expect(
      svc.createKey(USER, { name: 'x', role: 'user', tenantId: 't1' }),
    ).rejects.toThrow(/admin/i);
    await expect(
      svc.createKey(ADMIN, { name: 'x', role: 'superadmin', tenantId: 't1' }),
    ).rejects.toThrow(/exceed/i);
    await expect(
      svc.createKey(ADMIN, { name: 'x', role: 'user', tenantId: 't2' }),
    ).rejects.toThrow(/own tenant/i);
    await expect(
      svc.createKey({ ...ADMIN, viaApiKey: true }, { name: 'x', role: 'user', tenantId: 't1' }),
    ).rejects.toThrow(/cannot create/i);
  });

  it('superadmin creates platform-wide keys; admin lists own tenant only', async () => {
    await svc.createKey(SUPER, { name: 'platform', role: 'admin', tenantId: null });
    await svc.createKey(ADMIN, { name: 'scoped', role: 'user', tenantId: 't1' });

    const adminKeys = await svc.listKeys(ADMIN);
    expect(adminKeys.map((k) => k.name)).toEqual(['scoped']);

    const superKeys = await svc.listKeys(SUPER);
    expect(superKeys.map((k) => k.name).sort()).toEqual(['platform', 'scoped']);

    await expect(svc.listKeys(USER)).rejects.toThrow();
  });

  it('builds a non-doubled prefix from og_-prefixed secrets', () => {
    expect(prefixOfSecret('og_abcdefgh123456')).toBe('og_abcdefgh');
    expect(prefixOfSecret('og_abcdefgh123456')).not.toContain('og_og_');
  });

  it('still verifies keys stored with the legacy doubled prefix', async () => {
    const store = new InMemoryApiKeyStore();
    const legacySvc = new ApiKeyService(store);
    const secret = 'og_legacytopsecretvalue1234567890';

    const record: ApiKey = {
      id: 'legacy-1',
      name: 'legacy',
      keyPrefix: `og_${secret.slice(0, 8)}`,
      keyHash: hashApiKey(secret),
      userId: 'u1',
      role: 'user',
      tenantId: 't1',
      expiresAt: null,
      revokedAt: null,
      createdBy: 'u0',
      createdAt: new Date().toISOString(),
    };
    await store.insert(record);

    expect(await legacySvc.verifyKey(secret)).toMatchObject({
      keyId: 'legacy-1',
      tenantId: 't1',
    });
  });

  it('admin cannot revoke cross-tenant keys', async () => {
    const other = await svc.createKey(SUPER, {
      name: 'foreign',
      role: 'admin',
      tenantId: 't9',
    });
    await expect(svc.revokeKey(ADMIN, other.key.id)).rejects.toThrow(/own tenant/i);
    await expect(svc.revokeKey(ADMIN, 'missing-id')).rejects.toThrow(
      NotFoundError,
    );
  });
});
