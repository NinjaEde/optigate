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

/** Standard RS256/JWKS bearer verification (e.g. Keycloak-issued tokens). */
export function verifyKeycloakToken(token: string): Promise<AuthContext | null> {
  const options: VerifyOptions = {
    audience,
    issuer: `${keycloakUrl}/realms/${realm}`,
    algorithms: ['RS256'],
  };

  return new Promise((resolve) => {
    jwt.verify(token, getKey, options, (err, decoded) => {
      if (err || !decoded) {
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
      const tenantId = payload.organization?.[0] ?? null;

      resolve({
        userId: payload.sub ?? 'unknown',
        role: mapRole([...realmRoles, ...clientRoles]),
        tenantId,
      });
    });
  });
}
