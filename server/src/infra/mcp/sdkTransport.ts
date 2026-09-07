import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpTransport } from './clientPool.js';
import { buildAuthHeaders } from './authHeaders.js';
import type { AuthConfig, MCPServer } from '../../domain/types.js';

/**
 * Resolves envRef names to actual secret values at connect time.
 * Values are never persisted — they live in the environment or a broker.
 */
export function resolveEnvRefs(refs: string[] = []): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const ref of refs) {
    const value = process.env[ref];
    if (value !== undefined) {
      resolved[ref] = value;
    }
  }

  return resolved;
}

/** Wraps the official MCP SDK client behind our transport interface. */
const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
);

export async function createSdkTransport(
  server: MCPServer,
  authOverride?: AuthConfig,
): Promise<McpTransport> {
  const client = new Client({
    name: 'optigate',
    version: pkg.version as string,
  });

  // per-tenant credential binding overrides the server's default auth
  const effectiveAuth = authOverride ?? server.connection.auth;

  if (server.transport === 'stdio') {
    const env = resolveEnvRefs(server.connection.envRefs);
    const transport = new StdioClientTransport({
      command: server.connection.command ?? '',
      args: server.connection.args ?? [],
      env: { ...env } as Record<string, string>,
    });
    await client.connect(transport);
  } else if (server.connection.url) {
    // SSRF guard: if SSRF_ALLOWED_HOSTS is set, only connect to allowed hosts
    assertAllowedUrl(server.connection.url);
    const url = new URL(server.connection.url);
    const headers = resolveHeaders(server.connection.customHeaders, server.connection.customHeadersEnvRefs, server.connection.envRefs, effectiveAuth);

    if (server.transport === 'sse') {
      const transport = new SSEClientTransport(url, {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
      await client.connect(transport);
    } else {
      // streamable_http — SDK negotiates the protocol variant automatically
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      });
      await client.connect(transport);
    }
  } else {
    throw new Error(`Cannot connect server "${server.name}": missing connection target`);
  }

  return {
    async connect() {
      /* already connected above */
    },

    async listTools() {
      const res = await client.listTools();
      return res.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    },

    async callTool(name, args) {
      return client.callTool({ name, arguments: args });
    },

    async close() {
      await client.close();
    },
  };
}

function resolveHeaders(
  customHeaders: Record<string, string> | undefined,
  customHeadersEnvRefs: Record<string, string> | undefined,
  envRefs: string[] | undefined,
  auth: AuthConfig | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...customHeaders,
    ...buildAuthHeaders(auth, customHeadersEnvRefs),
  };
  for (const ref of envRefs ?? []) {
    const value = process.env[ref];
    if (value !== undefined) {
      headers[`x-mcp-${ref.toLowerCase().replace(/_/g, '-')}`] = value;
    }
  }
  return headers;
}

const SSRF_DENY_HOSTS = new Set([
  '169.254.169.254', // cloud metadata endpoints
  '127.0.0.1',
  '0.0.0.0',
]);

/**
 * Validates that the URL target is allowed per the SSRF policy.
 * Uses SSRF_ALLOWED_HOSTS env (comma-separated globs) if set;
 * otherwise falls back to a deny-list of sensitive internal IPs.
 */
export function assertAllowedUrl(urlString: string): void {
  const url = new URL(urlString);
  const host = url.hostname;

  // explicit allowlist — everything else is rejected
  const allowed = process.env.SSRF_ALLOWED_HOSTS;
  if (allowed) {
    const patterns = allowed.split(',').map((p) => p.trim().toLowerCase());
    const match = patterns.some((pattern) => {
      if (pattern.startsWith('*.')) {
        return host.endsWith(pattern.slice(1));
      }
      return host === pattern;
    });
    if (!match) {
      throw new Error(
        `SSRF blocked: host "${host}" is not in SSRF_ALLOWED_HOSTS`,
      );
    }
    return;
  }

  // no allowlist → deny known dangerous targets (backwards compat)
  if (SSRF_DENY_HOSTS.has(host)) {
    throw new Error(
      `SSRF blocked: connection to "${host}" is not allowed`,
    );
  }

  // also block link-local and loopback ranges
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('169.254.')
  ) {
    throw new Error(
      `SSRF blocked: connection to loopback/link-local address "${host}" is not allowed`,
    );
  }
}
