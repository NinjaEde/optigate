import crypto from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets stored directly in the registry
 * (alternative to env/broker references). The key comes from
 * SECRET_ENCRYPTION_KEY; without it, direct secret storage is disabled
 * and only references are allowed.
 */

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;
let cachedKeyRaw: string | null = null;

function getKey(): Buffer | null {
  const raw = process.env.SECRET_ENCRYPTION_KEY;
  if (!raw) {
    return null;
  }
  if (!cachedKey || cachedKeyRaw !== raw) {
    // derive a stable 32-byte key from the configured passphrase
    cachedKey = crypto.createHash('sha256').update(raw).digest();
    cachedKeyRaw = raw;
  }
  return cachedKey;
}

export function encryptionEnabled(): boolean {
  return getKey() !== null;
}

/** Encrypts a plaintext secret → "enc:v1:<iv>:<tag>:<ciphertext>" or null. */
export function encryptSecret(plaintext: string): string | null {
  const key = getKey();
  if (!key) {
    return null;
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/** Decrypts an "enc:v1:…" payload back to plaintext, or null. */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith('enc:v1:')) {
    return null;
  }

  const key = getKey();
  if (!key) {
    return null;
  }

  const [, , ivB64, tagB64, dataB64] = stored.split(':');
  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith('enc:v1:');
}
