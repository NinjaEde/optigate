import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';

import jwt from 'jsonwebtoken';

import type { AuthContext } from '../../domain/types.js';
import { sanitizeTenantId } from './keycloak.js';

function scryptKey(
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(key as Buffer);
    });
  });
}

// scrypt parameters: memory-hard, interactive-login friendly (~50-100ms).
// Stored format is versioned so a future KDF switch can migrate gradually:
//   scrypt$<N>$<r>$<p>$<saltB64url>$<hashB64url>
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export const LOCAL_JWT_ALGORITHM = 'HS256' as const;

export interface LocalTokenClaims {
  userId: string;
  role: AuthContext['role'];
  tenantId: string | null;
}

/** scrypt hash with random salt. Format: scrypt$N$r$p$salt$hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptKey(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/** Constant-time password check. Unknown/malformed hashes resolve false. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      return false;
    }
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const opts = { N: Number(nStr), r: Number(rStr), p: Number(pStr) };
    if (
      !Number.isFinite(opts.N)
      || !Number.isFinite(opts.r)
      || !Number.isFinite(opts.p)
    ) {
      return false;
    }
    const expected = Buffer.from(hashB64, 'base64url');
    const derived = await scryptKey(
      password,
      Buffer.from(saltB64, 'base64url'),
      expected.length,
      opts,
    );
    if (derived.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Usernames are matched case-insensitively; stored lowercase. */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value.trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9._-]{3,64}$/.test(name)) {
    return null;
  }
  return name;
}

/** Accepts "12h", "30m", "7d", "900s" or plain milliseconds. */
export function parseTtl(value: string | undefined, fallbackMs: number): number {
  if (!value) {
    return fallbackMs;
  }
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!m) {
    return fallbackMs;
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const factor
    = unit === 'd' ? 86_400_000
      : unit === 'h' ? 3_600_000
        : unit === 'm' ? 60_000
          : unit === 's' ? 1000
            : 1;
  return n * factor;
}

/** Short fingerprint of the secret for boot logs (never the secret). */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

export function signLocalToken(
  user: { id: string; username: string; role: AuthContext['role']; tenantId: string | null },
  secret: string,
  ttlMs: number,
): { token: string; expiresAt: string } {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role, tid: user.tenantId },
    secret,
    {
      algorithm: LOCAL_JWT_ALGORITHM,
      expiresIn: Math.max(1, Math.floor(ttlMs / 1000)),
    },
  );
  return { token, expiresAt };
}

/**
 * Verifies a self-signed HS256 local token. Failures resolve to null —
 * callers map that to 401 without leaking a reason.
 */
export function verifyLocalToken(
  token: string,
  secret: string,
): LocalTokenClaims | null {
  try {
    const decoded = jwt.verify(token, secret, {
      algorithms: [LOCAL_JWT_ALGORITHM],
    }) as jwt.JwtPayload & {
      sub?: string;
      role?: string;
      tid?: string | null;
    };
    if (typeof decoded.sub !== 'string' || !decoded.sub) {
      return null;
    }
    const role: AuthContext['role']
      = decoded.role === 'superadmin' || decoded.role === 'admin' ? decoded.role : 'user';
    return {
      userId: decoded.sub,
      role,
      tenantId: sanitizeTenantId(decoded.tid),
    };
  } catch {
    return null;
  }
}
