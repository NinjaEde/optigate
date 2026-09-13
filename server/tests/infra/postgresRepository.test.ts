import { describe, it, expect, vi } from 'vitest';

/**
 * Contract tests: the Postgres repository must behave exactly like the
 * in-memory one. A queryable pg instance is required; when DATABASE_URL
 * is not set (e.g. plain local test run) these tests are skipped.
 */

const DATABASE_URL = process.env.DATABASE_URL;

const maybe = DATABASE_URL ? describe : describe.skip;

maybe('PostgresServerRepository (contract)', () => {
  it('persists and retrieves a server', async () => {
    const { PostgresServerRepository } = await import(
      '../../src/infra/repositories/postgresRepository'
    );
    const repo = await PostgresServerRepository.create(DATABASE_URL as string);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await repo.insert({
      id,
      tenantId: 't1',
      name: `srv-${id.slice(0, 8)}`,
      description: '',
      scope: 'tenant',
      shared: false,
      ownerId: null,
      transport: 'streamable_http',
      connection: { url: 'https://x.example.com' },
      status: 'healthy',
      createdBy: 'u1',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });

    const found = await repo.findById(id);
    expect(found).not.toBeNull();
    expect(found?.tenantId).toBe('t1');
  });
});

maybe('PostgresApiKeyStore (contract)', () => {
  it('persists keys and finds them by prefix', async () => {
    const { Pool } = await import('pg');
    const {
      PostgresApiKeyStore,
      PostgresServerRepository,
    } = await import('../../src/infra/repositories/postgresRepository');
    // bootstrap schema (CREATE TABLE IF NOT EXISTS)
    await PostgresServerRepository.create(DATABASE_URL as string);
    const pool = new Pool({ connectionString: DATABASE_URL as string });
    try {
      const store = new PostgresApiKeyStore(pool);
      const now = new Date().toISOString();
      await store.insert({
        id: crypto.randomUUID(),
        name: 'contract-key',
        keyPrefix: 'og_contract1',
        keyHash: 'a'.repeat(64),
        userId: 'u1',
        role: 'admin',
        tenantId: 't1',
        expiresAt: null,
        revokedAt: null,
        createdBy: 'u0',
        createdAt: now,
      });

      const found = await store.findByPrefix('og_contract1');
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe('contract-key');
      expect(found[0].tenantId).toBe('t1');
      expect(await store.findByPrefix('og_missing')).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});

maybe('PostgresSettingsStore (contract)', () => {
  it('persists, reads and deletes overrides', async () => {
    const { Pool } = await import('pg');
    const { PostgresSettingsStore } = await import(
      '../../src/infra/repositories/postgresRepository'
    );
    const pool = new Pool({ connectionString: DATABASE_URL as string });
    try {
      // ensureSchema equivalent: reuse the server repo bootstrap
      const { PostgresServerRepository } = await import(
        '../../src/infra/repositories/postgresRepository'
      );
      await PostgresServerRepository.create(DATABASE_URL as string);

      const store = new PostgresSettingsStore(pool);
      expect(await store.get('ratelimit.max')).toBeUndefined();

      await store.set('ratelimit.max', 500, 'u0');
      expect(await store.get('ratelimit.max')).toBe(500);

      const all = await store.all();
      expect(all['ratelimit.max']).toBe(500);

      await store.delete('ratelimit.max');
      expect(await store.get('ratelimit.max')).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});

it('placeholder keeps vitest happy with zero tests when skipped', () => {
  expect(true).toBe(true);
});

// silence unused import warning path
void vi;
