import { describe, it, expect, beforeEach } from 'vitest';

import { CredentialResolver } from '../../src/infra/mcp/credentialResolver.js';
import type { AuthContext } from '../../src/domain/types.js';

const ctx = (tenantId: string | null): AuthContext => ({
  userId: 'u1',
  role: 'admin',
  tenantId,
});

describe('CredentialResolver', () => {
  let resolver: CredentialResolver;

  beforeEach(() => {
    resolver = new CredentialResolver();
  });

  describe('binding management', () => {
    it('starts with no bindings', () => {
      expect(resolver.listBindings('srv-1')).toEqual([]);
    });

    it('stores and lists a tenant binding without secret material', () => {
      resolver.setBinding('srv-1', 'acme', { type: 'bearer', secretRef: 'ACME_KEY' });

      const bindings = resolver.listBindings('srv-1');
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toEqual({
        serverId: 'srv-1',
        tenantId: 'acme',
        auth: { type: 'bearer', secretRef: 'ACME_KEY' },
      });
    });

    it('replaces an existing binding for the same tenant', () => {
      resolver.setBinding('srv-1', 'acme', { type: 'bearer', secretRef: 'OLD' });
      resolver.setBinding('srv-1', 'acme', { type: 'api_key', secretRef: 'NEW' });

      expect(resolver.listBindings('srv-1')).toHaveLength(1);
      expect(resolver.resolve('srv-1', ctx('acme'))?.secretRef).toBe('NEW');
    });

    it('deletes a binding; tenant falls back afterwards', () => {
      resolver.setBinding('srv-1', null, { type: 'none' });
      resolver.setBinding('srv-1', 'acme', { type: 'bearer', secretRef: 'A' });

      resolver.deleteBinding('srv-1', 'acme');

      expect(resolver.listBindings('srv-1')).toHaveLength(1);
      // falls back to default
      expect(resolver.resolve('srv-1', ctx('acme'))).toEqual({ type: 'none' });
    });

    it('keeps bindings of different servers isolated', () => {
      resolver.setBinding('srv-1', 'acme', { type: 'bearer', secretRef: 'S1' });
      resolver.setBinding('srv-2', 'acme', { type: 'bearer', secretRef: 'S2' });

      expect(resolver.resolve('srv-1', ctx('acme'))?.secretRef).toBe('S1');
      expect(resolver.resolve('srv-2', ctx('acme'))?.secretRef).toBe('S2');
    });
  });

  describe('resolve precedence', () => {
    beforeEach(() => {
      resolver.setBinding('srv-1', 'globex', { type: 'bearer', secretRef: 'GLOBEX_KEY' });
      resolver.setBinding('srv-1', null, { type: 'api_key', secretRef: 'DEFAULT_KEY' });
    });

    it('uses the exact tenant binding when present', () => {
      expect(resolver.resolve('srv-1', ctx('globex'))).toEqual({
        type: 'bearer',
        secretRef: 'GLOBEX_KEY',
      });
    });

    it('falls back to the default binding when no tenant match', () => {
      expect(resolver.resolve('srv-1', ctx('unknown-corp'))).toEqual({
        type: 'api_key',
        secretRef: 'DEFAULT_KEY',
      });
    });

    it('returns undefined when neither tenant nor default binding exists', () => {
      expect(resolver.resolve('srv-x', ctx('globex'))).toBeUndefined();
    });

    it('treats a caller without tenant as default scope', () => {
      expect(resolver.resolve('srv-1', ctx(null))).toEqual({
        type: 'api_key',
        secretRef: 'DEFAULT_KEY',
      });
    });
  });
});
