import { describe, it, expect } from 'vitest';

import {
  buildAuthHeaders,
  sanitizeAuthForClient as _sanitize,
} from '../../src/infra/mcp/authHeaders';
import { encryptSecret } from '../../src/infra/secrets/secretVault';
import type { AuthConfig } from '../../src/domain/types';

// ensure the sanitizer is covered by the type system even if not asserted here
void _sanitize;

const withEnv = (env: Record<string, string>, fn: () => void) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

describe('buildAuthHeaders', () => {
  it('returns empty headers for type none / missing config', () => {
    expect(buildAuthHeaders({ type: 'none' })).toEqual({});
    expect(buildAuthHeaders(undefined)).toEqual({});
  });

  it('bearer: Authorization header with prefix and resolved secret', () => {
    withEnv({ MY_TOKEN: 'tok123' }, () => {
      const auth: AuthConfig = { type: 'bearer', secretRef: 'MY_TOKEN' };
      expect(buildAuthHeaders(auth)).toEqual({
        Authorization: 'Bearer tok123',
      });
    });
  });

  it('api_key: custom header name with raw key', () => {
    withEnv({ KEY: 'abc' }, () => {
      const auth: AuthConfig = {
        type: 'api_key',
        secretRef: 'KEY',
        headerName: 'x-api-key',
      };
      expect(buildAuthHeaders(auth)).toEqual({ 'x-api-key': 'abc' });
    });
  });

  it('custom_headers: maps each env ref to its header name', () => {
    withEnv({ TENANT: 'acme' }, () => {
      const auth: AuthConfig = { type: 'custom_headers' };
      expect(buildAuthHeaders(auth, { 'x-tenant': 'TENANT' })).toEqual({
        'x-tenant': 'acme',
      });
    });
  });

  it('missing secret yields no header (no crash)', () => {
    const auth: AuthConfig = { type: 'bearer', secretRef: 'NOT_SET' };
    expect(buildAuthHeaders(auth)).toEqual({});
  });

  it('prefers encrypted secret over env reference', () => {
    let stored: string;
    withEnv({ MY_TOKEN: 'from-env' }, () => {
      withKey(() => {
        stored = encryptSecret('from-vault') as string;
        const headers = buildAuthHeaders({
          type: 'bearer',
          secretEnc: stored,
          secretRef: 'MY_TOKEN',
        });
        expect(headers['Authorization']).toBe('Bearer from-vault');
      });
    });
  });

  function withKey(fn: () => void) {
    const saved = process.env.SECRET_ENCRYPTION_KEY;
    process.env.SECRET_ENCRYPTION_KEY = 'k1';
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
      else process.env.SECRET_ENCRYPTION_KEY = saved;
    }
  }
});
