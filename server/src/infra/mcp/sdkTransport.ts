import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpTransport } from './clientPool.js';
import { buildAuthHeaders } from './authHeaders.js';
import type { MCPServer } from '../../domain/types.js';

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
export async function createSdkTransport(server: MCPServer): Promise<McpTransport> {
  const client = new Client({
    name: 'optigate',
    version: '1.0.0',
  });

  if (server.transport === 'stdio') {
    const env = resolveEnvRefs(server.connection.envRefs);
    const transport = new StdioClientTransport({
      command: server.connection.command ?? '',
      args: server.connection.args ?? [],
      env: { ...env } as Record<string, string>,
    });
    await client.connect(transport);
  } else if (server.connection.url) {
    // streamable_http and sse both use the HTTP transport; the SDK
    // negotiates SSE fallback automatically.
    const url = new URL(server.connection.url);
    const headers = resolveHeaders(server);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
    await client.connect(transport);
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

function resolveHeaders(server: MCPServer): Record<string, string> {
  const headers: Record<string, string> = {
    // static key/value headers — independent of the auth profile
    ...server.connection.customHeaders,
    ...buildAuthHeaders(
      server.connection.auth,
      server.connection.customHeadersEnvRefs,
    ),
  };
  for (const ref of server.connection.envRefs ?? []) {
    const value = process.env[ref];
    if (value !== undefined) {
      headers[`x-mcp-${ref.toLowerCase().replace(/_/g, '-')}`] = value;
    }
  }
  return headers;
}
