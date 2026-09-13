import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { InMemorySettingsStore } from '../../src/infra/repositories/memorySettingsStore';
import { SettingsService } from '../../src/services/settingsService';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/services/errors';
import type { AuthContext } from '../../src/domain/types';

const SUPER: AuthContext = { userId: 'u0', role: 'superadmin', tenantId: null };
const ADMIN: AuthContext = { userId: 'u1', role: 'admin', tenantId: 't1' };
const USER: AuthContext = { userId: 'u2', role: 'user', tenantId: 't1' };

const SAVED_ENV: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in SAVED_ENV)) {
      SAVED_ENV[k] = process.env[k];
    }
    process.env[k] = v;
  }
}

function clearEnv(vars: string[]) {
  for (const k of vars) {
    if (!(k in SAVED_ENV)) {
      SAVED_ENV[k] = process.env[k];
    }
    delete process.env[k];
  }
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(SAVED_ENV)) delete SAVED_ENV[k];
});

function makeService(): SettingsService {
  return new SettingsService(new InMemorySettingsStore());
}

describe('SettingsService', () => {
  let svc: SettingsService;

  beforeEach(() => {
    clearEnv([
      'RATE_LIMIT_MAX',
      'RECONCILE_INTERVAL_MS',
      'APPROVAL_REQUIRED',
      'SSRF_ALLOWED_HOSTS',
      'SSRF_ALLOW_PRIVATE_RANGES',
    ]);
    svc = makeService();
  });

  it('returns built-in defaults without overrides', async () => {
    expect(await svc.get<number>('ratelimit.max')).toBe(200);
    expect(await svc.get<boolean>('registry.approvalRequired')).toBe(true);
    expect(await svc.get<string>('ssrf.allowedHosts')).toBe('');
    expect(await svc.get<boolean>('ssrf.allowPrivateRanges')).toBe(false);
  });

  it('prefers env over default and DB over env', async () => {
    setEnv({ RATE_LIMIT_MAX: '500' });
    expect(await svc.get<number>('ratelimit.max')).toBe(500);

    await svc.set(SUPER, 'ratelimit.max', 1000);
    expect(await svc.get<number>('ratelimit.max')).toBe(1000);
  });

  it('parses boolean env loosely', async () => {
    // fresh instances: get() caches per key for 5s
    setEnv({ SSRF_ALLOW_PRIVATE_RANGES: '1' });
    expect(await makeService().get<boolean>('ssrf.allowPrivateRanges')).toBe(true);
    setEnv({ SSRF_ALLOW_PRIVATE_RANGES: 'yes' });
    expect(await makeService().get<boolean>('ssrf.allowPrivateRanges')).toBe(true);
    setEnv({ SSRF_ALLOW_PRIVATE_RANGES: '0' });
    expect(await makeService().get<boolean>('ssrf.allowPrivateRanges')).toBe(false);
  });

  it('ignores unparseable numeric env', async () => {
    setEnv({ RATE_LIMIT_MAX: 'lots' });
    expect(await svc.get<number>('ratelimit.max')).toBe(200);
  });

  it('rejects unknown keys, wrong types and out-of-range values', async () => {
    await expect(svc.set(SUPER, 'nope.nothing', 1)).rejects.toThrow(NotFoundError);
    await expect(svc.set(SUPER, 'ratelimit.max', 'fast')).rejects.toThrow(ValidationError);
    await expect(svc.set(SUPER, 'ratelimit.max', 0)).rejects.toThrow(ValidationError);
    await expect(svc.set(SUPER, 'ratelimit.max', 100001)).rejects.toThrow(ValidationError);
    await expect(
      svc.set(SUPER, 'ssrf.allowPrivateRanges', 'true'),
    ).rejects.toThrow(ValidationError);
  });

  it('enforces minRole: admins manage operational keys, superadmins everything', async () => {
    await svc.set(ADMIN, 'ratelimit.max', 300);
    expect(await svc.get<number>('ratelimit.max')).toBe(300);

    await expect(
      svc.set(ADMIN, 'ssrf.allowPrivateRanges', true),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      svc.set(ADMIN, 'registry.approvalRequired', false),
    ).rejects.toThrow(ForbiddenError);
    await expect(svc.set(USER, 'ratelimit.max', 300)).rejects.toThrow(ForbiddenError);
    await expect(
      svc.set({ ...ADMIN, viaApiKey: true }, 'ratelimit.max', 300),
    ).rejects.toThrow(ForbiddenError);
  });

  it('reset falls back to env then default', async () => {
    await svc.set(SUPER, 'ratelimit.max', 1000);
    await svc.reset(SUPER, 'ratelimit.max');
    expect(await svc.get<number>('ratelimit.max')).toBe(200);

    setEnv({ RATE_LIMIT_MAX: '700' });
    await svc.set(SUPER, 'ratelimit.max', 1000);
    await svc.reset(SUPER, 'ratelimit.max');
    expect(await svc.get<number>('ratelimit.max')).toBe(700);
  });

  it('list reports effective values with sources', async () => {
    setEnv({ RATE_LIMIT_MAX: '500' });
    await svc.set(SUPER, 'audit.limit', 50);

    const list = await svc.list();
    const byKey = Object.fromEntries(list.map((s) => [s.key, s]));
    expect(byKey['ratelimit.max']).toMatchObject({ value: 500, source: 'env' });
    expect(byKey['audit.limit']).toMatchObject({ value: 50, source: 'db' });
    expect(byKey['search.defaultLimit']).toMatchObject({ value: 5, source: 'default' });
    expect(list.length).toBeGreaterThan(10);
  });

  it('getCached serves boot/env values synchronously', async () => {
    setEnv({ RATE_LIMIT_MAX: '500' });
    expect(svc.getCached<number>('ratelimit.max')).toBe(500);
    await svc.set(SUPER, 'ratelimit.max', 1000);
    expect(svc.getCached<number>('ratelimit.max')).toBe(1000);
    await svc.reset(SUPER, 'ratelimit.max');
    expect(svc.getCached<number>('ratelimit.max')).toBe(500);
  });
});
