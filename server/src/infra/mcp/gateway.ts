import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import type {
  AuthContext,
  MCPServer,
  ToolMeta,
} from '../../domain/types.js';
import type { DecisionModel } from '../../domain/toolDecision.js';
import {
  searchWithDecision,
  type ScoredTool,
} from '../decision/decisionSearch.js';

/** Shape of the tool index the gateway needs — mirrors app.ts's provider. */
export interface ToolIndexProvider {
  (
    auth: AuthContext,
    servers: MCPServer[],
  ): Promise<Array<ToolMeta & { serverName: string }>>;
}

/** Resolved per-request decision model (null = disabled/not configured). */
export interface ResolvedDecision {
  model: DecisionModel;
  /** Retrieval depth handed to the model for reranking. */
  candidatePool: number;
}

export interface GatewayOptions {
  resolveAuth(request: { headers: Record<string, unknown> }): Promise<AuthContext>;
  listVisibleServers(auth: AuthContext): Promise<MCPServer[]>;
  /**
   * Timeout per JSON-RPC dispatch in ms. Accepts a getter for runtime
   * tuning. Default: 30_000.
   */
  dispatchTimeoutMs?: number | (() => number);
  /** Default top-k for search_tools. Getter allowed. Default: 5. */
  searchDefaultLimit?: number | (() => number);
  /** Max top-k any client may request. Getter allowed. Default: 20. */
  searchMaxLimit?: number | (() => number);
  buildToolIndex: ToolIndexProvider;
  searchTools(
    tools: Array<ToolMeta & { serverName: string }>,
    query: string,
    limit: number,
  ):
    | Array<ToolMeta & { serverName: string; score: number }>
    | Promise<Array<ToolMeta & { serverName: string; score: number }>>;
  /**
   * Optional decision-model reranker. Called per request so runtime
   * settings changes apply immediately; null disables decision mode.
   */
  resolveDecision?: () => Promise<ResolvedDecision | null>;
  /**
   * Force decision-model reranking for every search_tools call while a
   * model is configured, regardless of the requested mode. Getter
   * allowed. Default: false.
   */
  decisionForce?: boolean | (() => boolean);
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

const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
);
const SERVER_INFO = { name: 'optigate', version: pkg.version as string };

/**
 * MCP facade ("aggregator") for the registry: exposes all visible registry
 * servers as exactly two meta tools:
 *
 *   search_tools(query, k, mode?)         → top-k tool cards across servers
 *   execute_tool(server_id, tool_name, args)
 *
 * search_tools supports an optional mode="decision": a decision-model
 * reranker (Jev / OpenAI-compatible) reorders the lexical candidate pool
 * and may report "no matching tool". Opt-in and fully fallback-safe.
 *
 * Stateless JSON mode over HTTP POST: every request is self-contained and
 * gets its own in-memory MCP session, which is torn down afterwards. That
 * makes the endpoint trivially proxyable (no sessions, no SSE) while the
 * protocol semantics stay fully compliant — clients talk real MCP.
 */
export function createMcpGateway(options: GatewayOptions) {
  const buildServer = (): McpServer =>
    new McpServer({ name: SERVER_INFO.name, version: SERVER_INFO.version });

  const resolveLimit = (
    opt: number | (() => number) | undefined,
    fallback: number,
  ): number =>
    typeof opt === 'function' ? opt() : (opt ?? fallback);

  const registerTools = (server: McpServer, auth: AuthContext) => {
    const defaultLimit = resolveLimit(options.searchDefaultLimit, 5);
    const maxLimit = resolveLimit(options.searchMaxLimit, 20);

    const toCard = (r: ScoredTool) => ({
      server_id: r.serverId,
      server: r.serverName,
      tool: r.name,
      description: r.description,
      inputSchema: r.inputSchema,
      score: r.score,
      ...(r.lexicalScore !== undefined ? { lexicalScore: r.lexicalScore } : {}),
    });

    const textBlock = (value: unknown) => ({
      type: 'text' as const,
      text: JSON.stringify(value, null, 2),
    });

    /**
     * Decision mode: shared two-stage search (lexical pool → model
     * rerank / "no match"), with any model failure falling back to
     * plain lexical results flagged in the metadata block.
     */
    const runDecisionSearch = async (
      index: Array<ToolMeta & { serverName: string }>,
      query: string,
      limit: number,
      forced: boolean,
    ) => {
      const { tools, meta } = await searchWithDecision(
        index,
        query,
        limit,
        options.searchTools,
        options.resolveDecision,
      );
      return {
        content: [
          textBlock(tools.map(toCard)),
          textBlock(forced ? { ...meta, forced: true } : meta),
        ],
      };
    };

    const isForceEnabled = (): boolean =>
      typeof options.decisionForce === 'function'
        ? options.decisionForce()
        : (options.decisionForce ?? false);

    server.registerTool(
      'search_tools',
      {
        title: 'Tools suchen',
        description:
          'Durchsucht alle freigegebenen MCP-Server der Registry und liefert '
          + 'die k relevantesten Tools mit Server-Zuordnung (token-sparend). '
          + 'Nutze dieses Tool vor execute_tool. Optional mode="decision": '
          + 'ein Decision Model rerankt die Kandidaten semantisch und kann '
          + 'auch "kein passendes Tool" melden. Der Server kann das Reranking '
          + 'zudem serverseitig forcieren (siehe Meta-Block im Ergebnis).',
        inputSchema: {
          query: z.string().describe('Freitext-Suche über Namen/Beschreibungen'),
          k: z.number().int().min(1).max(maxLimit).default(defaultLimit).optional(),
          mode: z
            .enum(['lexical', 'decision'])
            .default('lexical')
            .optional()
            .describe(
              'lexical: schnelle Stichwortsuche (Default). decision: '
                + 'semantisches Reranking per Decision Model, sofern aktiviert.',
            ),
        },
      },
      async ({ query, k, mode }) => {
        const servers = await options.listVisibleServers(auth);
        const index = await options.buildToolIndex(auth, servers);
        const limit = Math.min(k ?? defaultLimit, maxLimit);
        const forced = mode !== 'decision' && isForceEnabled();

        if (mode !== 'decision' && !forced) {
          const results = await options.searchTools(index, query ?? '', limit);
          return { content: [textBlock(results.map(toCard))] };
        }

        return runDecisionSearch(index, query ?? '', limit, forced);
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

      const timeoutMs =
        typeof options.dispatchTimeoutMs === 'function'
          ? options.dispatchTimeoutMs()
          : (options.dispatchTimeoutMs ?? 30_000);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('MCP dispatch timeout')), timeoutMs),
      );
      const response = await Promise.race([responsePromise, timeout]);

      return { status: 200, body: response };
    } catch (err) {
      return {
        status: 502,
        body: jsonRpcError(body.id ?? null, -32000, (err as Error).message),
      };
    } finally {
      // allSettled: a failing close must not mask the real result or
      // surface as an unhandled rejection
      await Promise.allSettled([
        mcpServer.close(),
        serverTransport.close(),
        clientTransport.close(),
      ]);
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
