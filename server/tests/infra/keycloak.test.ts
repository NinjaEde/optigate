import { describe, it, expect } from 'vitest';

import { sanitizeTenantId } from '../../src/infra/auth/keycloak';

describe('sanitizeTenantId', () => {
  it('accepts well-formed tenant ids', () => {
    expect(sanitizeTenantId('acme-corp')).toBe('acme-corp');
    expect(sanitizeTenantId('t1')).toBe('t1');
    expect(sanitizeTenantId('org.example_01')).toBe('org.example_01');
  });

  it('rejects missing, empty and malformed values', () => {
    expect(sanitizeTenantId(undefined)).toBeNull();
    expect(sanitizeTenantId(null)).toBeNull();
    expect(sanitizeTenantId('')).toBeNull();
    expect(sanitizeTenantId('   ')).toBeNull();
    expect(sanitizeTenantId(42)).toBeNull();
    expect(sanitizeTenantId('tenant; DROP TABLE')).toBeNull();
    expect(sanitizeTenantId('../../etc')).toBeNull();
    expect(sanitizeTenantId('a'.repeat(201))).toBeNull();
  });
});
