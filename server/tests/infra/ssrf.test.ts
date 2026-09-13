import { describe, it, expect, afterEach } from 'vitest';

import {
  assertAllowedUrl,
  embeddedIPv4,
} from '../../src/infra/mcp/sdkTransport';

afterEach(() => {
  delete process.env.SSRF_ALLOWED_HOSTS;
});

describe('assertAllowedUrl (default deny mode, no DNS needed)', () => {
  it.each([
    'http://127.0.0.1:8100/mcp',
    'http://127.1.2.3/mcp',
    'http://0.0.0.0/mcp',
    'http://10.1.2.3/mcp',
    'http://172.16.5.4/mcp',
    'http://192.168.1.10/mcp',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/mcp',
    'http://localhost:8100/mcp',
    // non-standard IP literal forms parsers may normalize to loopback
    'http://2130706433/mcp',
    'http://0x7f000001/mcp',
    'http://0177.0.0.01/mcp',
    'http://[::1]/mcp',
    'http://[::]/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'http://[fe80::1]/mcp',
    'http://[fc00::1]/mcp',
    // transition forms hiding loopback in embedded IPv4
    'http://[2002:7f00:1::]/mcp',
    'http://[2001:0:4136:e378:8000:63bf:80ff:ffff]/mcp',
    'http://[64:ff9b::7f00:1]/mcp',
    'http://[64:ff9b::127.0.0.1]/mcp',
  ])('blocks %s', async (url) => {
    await expect(assertAllowedUrl(url)).rejects.toThrow(/SSRF blocked/);
  });

  it.each([
    'http://[2001:4860:4860::8888]/mcp',
    'http://[::ffff:8.8.8.8]/mcp',
    'http://[2002:808:808::]/mcp',
  ])('allows global unicast %s', async (url) => {
    // literal check passes without DNS; must not throw the SSRF error
    await expect(assertAllowedUrl(url)).resolves.toBeUndefined();
  });

  it('rejects unresolvable hosts fail-closed', async () => {
    await expect(
      assertAllowedUrl('https://nonexistent.invalid/mcp'),
    ).rejects.toThrow(/SSRF blocked/);
  });
});

describe('embeddedIPv4', () => {
  it('decodes mapped, compatible, 6to4, Teredo and NAT64 forms', () => {
    expect(embeddedIPv4('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(embeddedIPv4('::127.0.0.1')).toBe('127.0.0.1');
    expect(embeddedIPv4('2002:7f00:1::')).toBe('127.0.0.1');
    expect(embeddedIPv4('2002:808:808::')).toBe('8.8.8.8');
    // Teredo example from RFC 4380 section 4 (client 192.0.2.45 obfuscated)
    expect(embeddedIPv4('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(
      '192.0.2.45',
    );
    expect(embeddedIPv4('64:ff9b::7f00:1')).toBe('127.0.0.1');
    expect(embeddedIPv4('64:ff9b::127.0.0.1')).toBe('127.0.0.1');
  });

  it('returns null for plain IPv6', () => {
    expect(embeddedIPv4('2001:4860:4860::8888')).toBeNull();
    expect(embeddedIPv4('fe80::1')).toBeNull();
  });
});

describe('assertAllowedUrl (allowPrivateRanges opt-out)', () => {
  const flag = { allowPrivateRanges: true };

  it.each([
    'http://192.168.1.1/mcp',
    'http://10.0.0.5/mcp',
    'http://127.0.0.1:8100/mcp',
    'http://localhost:8100/mcp',
    'http://[::1]/mcp',
  ])('allows %s with the flag', async (url) => {
    await expect(assertAllowedUrl(url, flag)).resolves.toBeUndefined();
  });

  it('still enforces a configured allowlist', async () => {
    await expect(
      assertAllowedUrl('http://192.168.1.1/mcp', {
        allowedHosts: 'other.example',
        allowPrivateRanges: true,
      }),
    ).rejects.toThrow(/not in SSRF_ALLOWED_HOSTS/);
  });

  it('reads the flag from the environment', async () => {
    process.env.SSRF_ALLOW_PRIVATE_RANGES = 'true';
    try {
      await expect(
        assertAllowedUrl('http://192.168.1.1/mcp'),
      ).resolves.toBeUndefined();
    } finally {
      delete process.env.SSRF_ALLOW_PRIVATE_RANGES;
    }
  });
});

describe('assertAllowedUrl (allowlist mode)', () => {
  it('allows listed hosts and rejects everything else', async () => {
    process.env.SSRF_ALLOWED_HOSTS = 'mcp.example.com, *.trusted.example';
    await expect(
      assertAllowedUrl('https://mcp.example.com/mcp'),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedUrl('https://api.trusted.example/mcp'),
    ).resolves.toBeUndefined();
    await expect(
      assertAllowedUrl('https://evil.example/mcp'),
    ).rejects.toThrow(/not in SSRF_ALLOWED_HOSTS/);
  });
});
