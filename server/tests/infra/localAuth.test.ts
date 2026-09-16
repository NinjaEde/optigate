import { describe, it, expect } from 'vitest';

import {
  hashPassword,
  normalizeUsername,
  parseTtl,
  signLocalToken,
  verifyLocalToken,
  verifyPassword,
} from '../../src/infra/auth/local';

const SECRET = 'test-secret-with-at-least-32-characters!!';

describe('local auth crypto', () => {
  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces unique salts per hash', async () => {
    const a = await hashPassword('same-password-here');
    const b = await hashPassword('same-password-here');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-here', a)).toBe(true);
    expect(await verifyPassword('same-password-here', b)).toBe(true);
  });

  it('rejects malformed stored hashes', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt$2b$10$abc')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });

  it('signs and verifies tokens', () => {
    const { token } = signLocalToken(
      { id: 'u1', username: 'alice', role: 'admin', tenantId: 't1' },
      SECRET,
      3_600_000,
    );
    const claims = verifyLocalToken(token, SECRET);
    expect(claims).toMatchObject({ userId: 'u1', role: 'admin', tenantId: 't1' });
  });

  it('rejects tokens with the wrong secret', () => {
    const { token } = signLocalToken(
      { id: 'u1', username: 'alice', role: 'user', tenantId: null },
      SECRET,
      3_600_000,
    );
    expect(verifyLocalToken(token, 'other-secret-xxxxxxxxxxxxxxx12345')).toBeNull();
  });

  it('rejects garbage tokens', () => {
    expect(verifyLocalToken('not.a.token', SECRET)).toBeNull();
    expect(verifyLocalToken('', SECRET)).toBeNull();
  });
});

describe('normalizeUsername', () => {
  it('lowercases and trims', () => {
    expect(normalizeUsername('  Alice_01 ')).toBe('alice_01');
  });

  it('rejects bad shapes', () => {
    expect(normalizeUsername('ab')).toBeNull();
    expect(normalizeUsername('has space')).toBeNull();
    expect(normalizeUsername('UPPER!')).toBeNull();
    expect(normalizeUsername(123)).toBeNull();
    expect(normalizeUsername('')).toBeNull();
  });
});

describe('parseTtl', () => {
  it('parses duration strings', () => {
    expect(parseTtl('12h', 0)).toBe(43_200_000);
    expect(parseTtl('30m', 0)).toBe(1_800_000);
    expect(parseTtl('7d', 0)).toBe(604_800_000);
    expect(parseTtl('900s', 0)).toBe(900_000);
    expect(parseTtl('5000', 0)).toBe(5000);
  });

  it('falls back on missing/garbage input', () => {
    expect(parseTtl(undefined, 123)).toBe(123);
    expect(parseTtl('soon', 123)).toBe(123);
  });
});
