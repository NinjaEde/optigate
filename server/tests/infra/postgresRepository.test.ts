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

it('placeholder keeps vitest happy with zero tests when skipped', () => {
  expect(true).toBe(true);
});

// silence unused import warning path
void vi;
