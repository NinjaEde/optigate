import { readFileSync } from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
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

export interface SsrfOptions {
  /**
   * Explicit allowlist (comma-separated, *. globs). Falls back to
   * SSRF_ALLOWED_HOSTS env when omitted.
   */
  allowedHosts?: string;
  /**
   * Also allow loopback/private/link-local targets. Falls back to
   * SSRF_ALLOW_PRIVATE_RANGES env. Home-lab only.
   */
  allowPrivateRanges?: boolean;
}

export async function createSdkTransport(
  server: MCPServer,
  authOverride?: AuthConfig,
  ssrf?: SsrfOptions,
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
    await assertAllowedUrl(server.connection.url, ssrf);
    const url = new URL(server.connection.url);
    const headers = resolveHeaders(server.connection.customHeaders, server.connection.customHeadersEnvRefs, effectiveAuth);

    // redirect: 'error' — the allowlist/range check below runs once, so
    // cross-origin redirects must fail closed instead of bypassing it.
    // (Register the final URL directly; http→https upgrades included.)
    const requestInit: RequestInit = { redirect: 'error' };
    if (Object.keys(headers).length) {
      requestInit.headers = headers;
    }

    if (server.transport === 'sse') {
      const transport = new SSEClientTransport(url, { requestInit });
      await client.connect(transport);
    } else {
      // streamable_http — SDK negotiates the protocol variant automatically
      const transport = new StreamableHTTPClientTransport(url, { requestInit });
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
  auth: AuthConfig | undefined,
): Record<string, string> {
  // Note: envRefs are intentionally NOT sent as headers. They feed stdio
  // process environments only — broadcasting secret values to upstream
  // HTTP servers would exfiltrate them to third parties.
  return {
    ...customHeaders,
    ...buildAuthHeaders(auth, customHeadersEnvRefs),
  };
}

/**
 * Non-routable/reserved ranges that outbound MCP connections must never
 * reach. Checked after DNS resolution, so hostname tricks (DNS rebinding
 * aside) cannot smuggle these past the guard.
 */
const BLOCKED_RANGES: Array<[string, number, 'ipv4' | 'ipv6']> = [
  ['127.0.0.0', 8, 'ipv4'], // loopback (incl. 127.0.0.1)
  ['0.0.0.0', 8, 'ipv4'], // "this network"
  ['10.0.0.0', 8, 'ipv4'], // private
  ['172.16.0.0', 12, 'ipv4'], // private
  ['192.168.0.0', 16, 'ipv4'], // private
  ['169.254.0.0', 16, 'ipv4'], // link-local (incl. cloud metadata)
  ['100.64.0.0', 10, 'ipv4'], // carrier-grade NAT
  ['::1', 128, 'ipv6'], // loopback
  ['::', 128, 'ipv6'], // unspecified
  ['fe80::', 10, 'ipv6'], // link-local
  ['fc00::', 7, 'ipv6'], // unique-local
  ['ff00::', 8, 'ipv6'], // multicast
  // NOTE: no ::ffff:0:0/96, 6to4, Teredo or NAT64 ranges here — Node's
  // BlockList evaluates IPv4 addresses against IPv6 rules in translated
  // space, so those rules match EVERY IPv4 address (false positives).
  // Embedded IPv4 in such forms is handled by embeddedIPv4() below.
];

const blockedRanges = new net.BlockList();
for (const [subnet, prefix, family] of BLOCKED_RANGES) {
  blockedRanges.addSubnet(subnet, prefix, family);
}

function rejectBlockedAddress(address: string, host: string): void {
  const family = net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
  if (blockedRanges.check(address, family)) {
    throw new Error(
      `SSRF blocked: "${host}" resolves to non-routable address "${address}"`,
    );
  }
  // IPv6 transition forms hide a routable decision inside an embedded
  // IPv4 address (e.g. ::ffff:127.0.0.1) — check that one too.
  const embedded = family === 'ipv6' ? embeddedIPv4(address) : null;
  if (embedded && embedded !== address) {
    rejectBlockedAddress(embedded, host);
  }
}

const HEX4 = '[0-9a-f]{1,4}';
const QUAD = '\\d{1,3}(?:\\.\\d{1,3}){3}';

/**
 * Extracts the IPv4 address embedded in IPv6 transition forms:
 * mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, 6to4 2002:V4::/48,
 * Teredo 2001::/32 (client IP = ~last32) and NAT64 64:ff9b::/96.
 * Host must already be lowercased. Returns null when none applies.
 */
export function embeddedIPv4(host: string): string | null {
  const dotted = host.match(new RegExp(`^::(?:ffff:)?(${QUAD})$`));
  if (dotted && net.isIPv4(dotted[1])) {
    return dotted[1];
  }

  const hextet = (s: string): number | null =>
    new RegExp(`^${HEX4}$`).test(s) ? parseInt(s, 16) : null;
  const quadOf = (hi: number, lo: number): string =>
    `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;

  // 6to4 2002:HHHH:HHHH:... — first 32 bits after the prefix
  let m = host.match(new RegExp(`^2002:(${HEX4}):(${HEX4})(?::|$)`));
  if (m) {
    const hi = hextet(m[1]);
    const lo = hextet(m[2]);
    if (hi !== null && lo !== null) {
      return quadOf(hi, lo);
    }
    return null;
  }

  // Teredo 2001:0000:....:....:....:obfHi:obfLo — client = ~last32
  m = host.match(
    new RegExp(`^2001:0{1,4}(?::${HEX4}){4}:(${HEX4}):(${HEX4})$`),
  );
  if (m) {
    const hi = hextet(m[1]);
    const lo = hextet(m[2]);
    if (hi !== null && lo !== null) {
      const raw = ((hi << 16) | lo) >>> 0;
      const client = (~raw) >>> 0;
      return quadOf((client >>> 16) & 0xffff, client & 0xffff);
    }
    return null;
  }

  // NAT64 well-known prefix 64:ff9b::/96 (dotted or hextet tail)
  m = host.match(
    new RegExp(`^64:ff9b::(?:(${QUAD})|(${HEX4}):(${HEX4}))$`),
  );
  if (m) {
    if (m[1] && net.isIPv4(m[1])) {
      return m[1];
    }
    const hi = m[2] ? hextet(m[2]) : null;
    const lo = m[3] ? hextet(m[3]) : null;
    if (hi !== null && lo !== null) {
      return quadOf(hi, lo);
    }
    return null;
  }

  return null;
}

/**
 * Validates that the URL target is allowed per the SSRF policy.
 * Uses SSRF_ALLOWED_HOSTS env (comma-separated globs) if set;
 * otherwise resolves the host and rejects non-routable targets.
 *
 * Residual risk: DNS rebinding between check and connect (TOCTOU).
 * For hostile networks, prefer SSRF_ALLOWED_HOSTS plus a resolving
 * egress proxy. Redirects are forced to fail closed via
 * `redirect: 'error'` on the transports.
 */
export async function assertAllowedUrl(
  urlString: string,
  opts?: SsrfOptions,
): Promise<void> {
  const url = new URL(urlString);
  // URL keeps IPv6 literals bracketed ([::1]) — strip for checks below
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  const allowPrivate =
    opts?.allowPrivateRanges
    ?? ['true', '1', 'yes'].includes(
      (process.env.SSRF_ALLOW_PRIVATE_RANGES ?? '').toLowerCase(),
    );

  // explicit allowlist — everything else is rejected
  const allowed = opts?.allowedHosts ?? process.env.SSRF_ALLOWED_HOSTS;
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

  // Private-range opt-out (explicit home-lab escape hatch): skips the
  // literal/range checks below. Unresolvable hosts still fail closed,
  // and a configured allowlist above still applies.
  if (allowPrivate) {
    return;
  }

  // Reject non-standard IP literal forms that parsers may normalize to
  // loopback/private (decimal/octal/hex IPv4, e.g. 2130706433, 0x7f000001).
  const looksNumericLiteral =
    /^[\d.]+$/.test(host) || /^0x[0-9a-fA-F.]+$/i.test(host);
  if (looksNumericLiteral && net.isIP(host) === 0) {
    throw new Error(
      `SSRF blocked: non-standard IP literal "${host}" is not allowed`,
    );
  }

  if (host === 'localhost') {
    throw new Error('SSRF blocked: "localhost" is not allowed');
  }

  // literal IP → check directly, no DNS involved
  if (net.isIP(host) !== 0) {
    rejectBlockedAddress(host, host);
    return;
  }

  // DNS name → every resolved address must be routable; unresolvable
  // hosts fail closed
  let addresses: dns.LookupAddress[];
  try {
    addresses = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error(`SSRF blocked: cannot resolve "${host}"`);
  }
  if (addresses.length === 0) {
    throw new Error(`SSRF blocked: "${host}" resolves to nothing`);
  }
  for (const { address } of addresses) {
    rejectBlockedAddress(address, host);
  }
}
