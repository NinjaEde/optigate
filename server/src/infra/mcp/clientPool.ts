import type { MCPServer, ToolMeta } from '../../domain/types.js';

/**
 * Minimal transport abstraction so the pool can be tested without real
 * MCP connections. The SDK-backed implementation lives in sdkTransport.
 */
export interface McpTransport {
  connect(): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  >;
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

export type TransportFactory = (server: MCPServer) => Promise<McpTransport>;

export class McpClientPool {
  private readonly connections = new Map<string, McpTransport>();
  private readonly toolCache = new Map<string, ToolMeta[]>();

  constructor(private readonly factory: TransportFactory) {}

  async syncTools(server: MCPServer): Promise<ToolMeta[]> {
    const transport = await this.getConnection(server);

    let raw: Awaited<ReturnType<McpTransport['listTools']>>;
    try {
      raw = await transport.listTools();
    } catch (err) {
      this.connections.delete(server.id);
      throw new Error(
        `Tool listing failed for "${server.name}": ${(err as Error).message}`,
      );
    }

    const now = new Date().toISOString();
    const tools: ToolMeta[] = raw.map((t) => ({
      serverId: server.id,
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object' },
      lastSeenAt: now,
    }));

    this.toolCache.set(server.id, tools);
    return tools;
  }

  cachedTools(serverId: string): ToolMeta[] {
    return this.toolCache.get(serverId) ?? [];
  }

  async callTool(
    server: MCPServer,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const transport = await this.getConnection(server);
    return transport.callTool(toolName, args);
  }

  async shutdown(): Promise<void> {
    for (const t of this.connections.values()) {
      await t.close().catch(() => undefined);
    }
    this.connections.clear();
  }

  /**
   * Closes the connection to one server and drops its cached tools.
   * Idempotent: unknown server ids resolve without error.
   */
  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (conn) {
      await conn.close().catch(() => undefined);
      this.connections.delete(serverId);
    }
    this.toolCache.delete(serverId);
  }

  private async getConnection(server: MCPServer): Promise<McpTransport> {
    let conn = this.connections.get(server.id);

    if (!conn) {
      conn = await this.factory(server);
      await conn.connect();
      this.connections.set(server.id, conn);
    }

    return conn;
  }
}
