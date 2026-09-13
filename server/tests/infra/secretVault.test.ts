import { describe, it, expect } from 'vitest';

import {
  encryptSecret,
  decryptSecret,
  encryptionEnabled,
  isEncryptedSecret,
} from '../../src/infra/secrets/secretVault';

const withKey = (key: string | undefined, fn: () => void) => {
  const saved = process.env.SECRET_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
  else process.env.SECRET_ENCRYPTION_KEY = key;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.SECRET_ENCRYPTION_KEY;
    else process.env.SECRET_ENCRYPTION_KEY = saved;
  }
};

describe('secretVault', () => {
  it('reports whether encryption is available', () => {
    withKey('test-key-0123456789abcdef01234567', () => expect(encryptionEnabled()).toBe(true));
    withKey('short', () => expect(encryptionEnabled()).toBe(false));
    withKey(undefined, () => expect(encryptionEnabled()).toBe(false));
  });

  it('round-trips a secret', () => {
    withKey('k1-0123456789abcdef0123456789abc', () => {
      const enc = encryptSecret('hunter2');
      expect(enc).not.toBeNull();
      expect(isEncryptedSecret(enc as string)).toBe(true);
      expect(decryptSecret(enc as string)).toBe('hunter2');
    });
  });

  it('produces different ciphertexts for the same plaintext', () => {
    withKey('k1-0123456789abcdef0123456789abc', () => {
      const a = encryptSecret('same');
      const b = encryptSecret('same');
      expect(a).not.toBe(b);
    });
  });

  it('cannot decrypt with a different key', () => {
    let stored: string;
    withKey('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', () => {
      stored = encryptSecret('data') as string;
    });
    withKey('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', () => {
      expect(decryptSecret(stored)).toBeNull();
    });
  });

  it('returns null without a key', () => {
    withKey(undefined, () => {
      expect(encryptSecret('x')).toBeNull();
    });
  });

  it('rejects non-encrypted payloads in decryptSecret', () => {
    expect(decryptSecret('plain-secret')).toBeNull();
  });
});
