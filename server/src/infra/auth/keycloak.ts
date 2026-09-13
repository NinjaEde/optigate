import jwt, { type JwtPayload, type VerifyOptions } from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';

import type { AuthContext } from '../../domain/types.js';

const keycloakUrl = process.env.KEYCLOAK_URL ?? '';
const realm = process.env.KEYCLOAK_REALM ?? 'optigate';
const audience = process.env.KEYCLOAK_AUDIENCE ?? realm;

const jwks = new JwksClient({
  jwksUri: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxAge: 86_400_000,
  rateLimit: true,
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err || !key) {
      callback(err ?? new Error('no signing key'));
      return;
    }
    callback(null, key.getPublicKey());
  });
}

function mapRole(roles: string[]): AuthContext['role'] {
  if (roles.includes('superadmin')) return 'superadmin';
  if (roles.includes('admin')) return 'admin';
  return 'user';
}

/** Tenant ids come from the IdP — accept only a safe shape. */
export function sanitizeTenantId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim();
  if (!id || id.length > 200 || !/^[A-Za-z0-9._-]+$/.test(id)) {
    return null;
  }
  return id;
}

/**
 * Standard RS256/JWKS bearer verification (e.g. Keycloak-issued tokens).
 *
 * Failures resolve to null and are reported via `log` (error name only —
 * never token material). Set REQUIRE_KNOWN_ROLE=true to additionally
 * reject tokens carrying none of the superadmin/admin/user roles.
 */
export function verifyKeycloakToken(
  token: string,
  log: (msg: string) => void = () => undefined,
): Promise<AuthContext | null> {
  const options: VerifyOptions = {
    audience,
    issuer: `${keycloakUrl}/realms/${realm}`,
    algorithms: ['RS256'],
  };

  return new Promise((resolve) => {
    jwt.verify(token, getKey, options, (err, decoded) => {
      if (err || !decoded) {
        log(`keycloak verify failed: ${err?.name ?? 'unknown error'}`);
        resolve(null);
        return;
      }

      const payload = decoded as JwtPayload & {
        realm_access?: { roles?: string[] };
        resource_access?: Record<string, { roles?: string[] }>;
        organization?: string[];
      };

      const realmRoles = payload.realm_access?.roles ?? [];
      const clientRoles = payload.resource_access?.[audience]?.roles ?? [];
      const roles = [...realmRoles, ...clientRoles];

      if (
        process.env.REQUIRE_KNOWN_ROLE === 'true'
        && !roles.some((r) => r === 'superadmin' || r === 'admin' || r === 'user')
      ) {
        log('keycloak verify failed: no recognized role claim');
        resolve(null);
        return;
      }

      resolve({
        userId: payload.sub ?? 'unknown',
        role: mapRole(roles),
        tenantId: sanitizeTenantId(payload.organization?.[0]),
      });
    });
  });
}
