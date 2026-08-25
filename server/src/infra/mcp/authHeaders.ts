import type { AuthConfig } from '../../domain/types.js';
import { decryptSecret } from '../secrets/secretVault.js';

/**
 * Builds outgoing HTTP headers for an MCP server's auth profile.
 *
 * Secret resolution order:
 *   1. secretEnc  — encrypted-at-rest value (AES-256-GCM)
 *   2. secretRef  — environment variable name
 *
 * Plaintext secrets never leave the backend; API responses only ever
 * contain references or the encrypted payload.
 */
export function resolveAuthSecret(auth: AuthConfig): string | undefined {
  if (auth.secretEnc) {
    return decryptSecret(auth.secretEnc) ?? undefined;
  }
  if (auth.secretRef) {
    return process.env[auth.secretRef];
  }
  return undefined;
}

export function buildAuthHeaders(
  auth: AuthConfig | undefined,
  customHeadersEnvRefs?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  if (!auth || auth.type === 'none') {
    return headers;
  }

  const secret = resolveAuthSecret(auth);

  switch (auth.type) {
    case 'bearer':
      if (secret) {
        headers['Authorization'] = `${auth.headerPrefix ?? 'Bearer'} ${secret}`;
      }
      break;

    case 'api_key':
      if (secret) {
        headers[auth.headerName ?? 'x-api-key'] = secret;
      }
      break;

    case 'custom_headers':
      for (const [headerName, envRef] of Object.entries(
        customHeadersEnvRefs ?? {},
      )) {
        const value = process.env[envRef];
        if (value !== undefined) {
          headers[headerName] = value;
        }
      }
      break;

    case 'oauth2':
      // static token injection: caller may provide a pre-fetched token via secret
      if (secret) {
        headers['Authorization'] = `Bearer ${secret}`;
      }
      break;

    default:
      break;
  }

  return headers;
}

/**
 * Removes secret material from an AuthConfig before sending it to clients.
 * Replaces encrypted payloads with a stable marker so the UI can show
 * "configured" without exposing the value.
 */
export function sanitizeAuthForClient(
  auth: AuthConfig | undefined,
): AuthConfig | undefined {
  if (!auth) {
    return undefined;
  }

  const clone: AuthConfig = { ...auth };
  if (clone.secretEnc) {
    delete clone.secretEnc;
    clone.secretRef = clone.secretRef ?? '__stored__';
  }
  if (clone.clientSecretEnc) {
    delete clone.clientSecretEnc;
    clone.clientSecretRef = clone.clientSecretRef ?? '__stored__';
  }
  return clone;
}
