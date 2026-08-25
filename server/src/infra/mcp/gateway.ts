import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import type {
  AuthContext,
  MCPServer,
  ToolMeta,
} from '../../domain/types.js';

/** Shape of the tool index the gateway needs — mirrors app.ts's provider. */
export interface ToolIndexProvider {
  (
    auth: AuthContext,
    servers: MCPServer[],
  ): Promise<Array<ToolMeta & { serverName: string }>>;
}

export interface GatewayOptions {
  resolveAuth(request: { headers: Record<string, unknown> }): Promise<AuthContext>;
  listVisibleServers(auth: AuthContext): Promise<MCPServer[]>;
  buildToolIndex: ToolIndexProvider;
  searchTools(
    tools: Array<ToolMeta & { serverName: string }>,
    query: string,
    limit: number,
  ):
    | Array<ToolMeta & { serverName: string; score: number }>
    | Promise<Array<ToolMeta & { serverName: string; score: number }>>;
  callTool(
    server: MCPServer,
    auth: AuthContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const SERVER_INFO = { name: 'optigate', version: '1.0.0' } as const;

/**
 * MCP facade ("aggregator") for the registry: exposes all visible registry
 * servers as exactly two meta tools:
 *
 *   search_tools(query, k)                → top-k tool cards across servers
 *   execute_tool(server_id, tool_name, args)
 *
 * Stateless JSON mode over HTTP POST: every request is self-contained and
 * gets its own in-memory MCP session, which is torn down afterwards. That
 * makes the endpoint trivially proxyable (no sessions, no SSE) while the
 * protocol semantics stay fully compliant — clients talk real MCP.
 */
export function createMcpGateway(options: GatewayOptions) {
  const buildServer = (): McpServer =>
    new McpServer({ name: SERVER_INFO.name, version: SERVER_INFO.version });

  const registerTools = (server: McpServer, auth: AuthContext) => {
    server.registerTool(
      'search_tools',
      {
        title: 'Tools suchen',
        description:
          'Durchsucht alle freigegebenen MCP-Server der Registry und liefert '
          + 'die k relevantesten Tools mit Server-Zuordnung (token-sparend). '
          + 'Nutze dieses Tool vor execute_tool.',
        inputSchema: {
          query: z.string().describe('Freitext-Suche über Namen/Beschreibungen'),
          k: z.number().int().min(1).max(20).default(5).optional(),
        },
      },
      async ({ query, k }) => {
        const servers = await options.listVisibleServers(auth);
        const index = await options.buildToolIndex(auth, servers);
        const results = await options.searchTools(
          index,
          query ?? '',
          Math.min(k ?? 5, 20),
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                results.map((r) => ({
                  server_id: r.serverId,
                  server: r.serverName,
                  tool: r.name,
                  description: r.description,
                  inputSchema: r.inputSchema,
                  score: r.score,
                })),
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    server.registerTool(
      'execute_tool',
      {
        title: 'Tool ausführen',
        description:
          'Führt ein Tool auf einem Registry-Server aus. Ermittle server_id '
          + 'und tool_name vorher mit search_tools.',
        inputSchema: {
          server_id: z.string().min(1),
          tool_name: z.string().min(1),
          args: z.record(z.string(), z.unknown()).optional(),
        },
      },
      async ({ server_id, tool_name, args }) => {
        try {
          const servers = await options.listVisibleServers(auth);
          const server = servers.find((s) => s.id === server_id);

          if (!server) {
            throw new Error('Server not found or not visible for this user');
          }
          if (server.status !== 'healthy') {
            throw new Error(`Server "${server.name}" is ${server.status}`);
          }

          const result = await options.callTool(server, auth, tool_name, args ?? {});

          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Tool-Ausführung fehlgeschlagen: ${(err as Error).message}`,
              },
            ],
          };
        }
      },
    );
  };

  /** Runs one JSON-RPC message through a fresh in-memory session. */
  async function dispatch(
    auth: AuthContext,
    body: JsonRpcRequest,
  ): Promise<{ status: number; body: unknown }> {
    if (!body.method) {
      return { status: 400, body: jsonRpcError(body.id ?? null, -32600, 'Missing method') };
    }

    if (body.method === 'initialize') {
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id: body.id ?? null,
          result: {
            protocolVersion: String(
              (body.params?.protocolVersion as string | undefined) ?? '2025-06-18',
            ),
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        },
      };
    }

    if (body.method === 'notifications/initialized') {
      return { status: 202, body: null };
    }

    if (body.method !== 'tools/list' && body.method !== 'tools/call') {
      return {
        status: 400,
        body: jsonRpcError(body.id ?? null, -32601, `Unknown method: ${body.method}`),
      };
    }

    const mcpServer = buildServer();
    registerTools(mcpServer, auth);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      clientTransport.onmessage = (message) => resolve(message as Record<string, unknown>);
      clientTransport.onerror = (err) => reject(err);
      serverTransport.onerror = (err) => reject(err);
    });

    try {
      await Promise.all([
        mcpServer.connect(serverTransport as Transport),
        clientTransport.start(),
      ]);

      // deliver from the CLIENT end of the pair → McpServer answers back
      await clientTransport.send(body as never);

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP dispatch timeout')), 30_000),
      );
      const response = await Promise.race([responsePromise, timeout]);

      return { status: 200, body: response };
    } catch (err) {
      return {
        status: 502,
        body: jsonRpcError(body.id ?? null, -32000, (err as Error).message),
      };
    } finally {
      void mcpServer.close();
      void serverTransport.close();
      void clientTransport.close();
    }
  }

  async function handleGatewayPost(
    headers: Record<string, unknown>,
    body: JsonRpcRequest,
  ): Promise<{ status: number; body: unknown }> {
    let auth: AuthContext;
    try {
      auth = await options.resolveAuth({ headers });
    } catch {
      return { status: 401, body: jsonRpcError(body.id ?? null, -32001, 'Unauthorized') };
    }

    return dispatch(auth, body);
  }

  return { handleGatewayPost };
}
