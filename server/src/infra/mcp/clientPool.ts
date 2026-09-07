import type { AuthConfig, AuthContext, MCPServer, ToolMeta } from '../../domain/types.js';
import type { ICredentialResolver } from './credentialResolver.js';

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

export type TransportFactory = (
  server: MCPServer,
  authOverride?: AuthConfig,
) => Promise<McpTransport>;

/** Lightweight args validation against a tool's inputSchema. */
export function validateArgs(
  toolName: string,
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown> | undefined,
): void {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return;
  }
  const schema = inputSchema as Record<string, unknown>;

  // validate required properties exist
  const required = schema.required;
  if (Array.isArray(required)) {
    for (const field of required) {
      const fieldName = String(field);
      if (!(fieldName in args)) {
        throw new Error(
          `Tool "${toolName}": missing required argument "${fieldName}"`,
        );
      }
    }
  }

  // validate type constraints for simple types
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(args)) {
      const propSchema = properties[key] as Record<string, unknown> | undefined;
      if (!propSchema || typeof propSchema !== 'object') {
        continue;
      }
      if (propSchema.type === 'string' && typeof value !== 'string') {
        throw new Error(
          `Tool "${toolName}": argument "${key}" must be a string`,
        );
      }
      if (propSchema.type === 'number' && typeof value !== 'number') {
        throw new Error(
          `Tool "${toolName}": argument "${key}" must be a number`,
        );
      }
      if (propSchema.type === 'integer' && !Number.isInteger(value)) {
        throw new Error(
          `Tool "${toolName}": argument "${key}" must be an integer`,
        );
      }
      if (propSchema.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(
          `Tool "${toolName}": argument "${key}" must be a boolean`,
        );
      }
      if (propSchema.type === 'array' && !Array.isArray(value)) {
        throw new Error(
          `Tool "${toolName}": argument "${key}" must be an array`,
        );
      }
    }
  }
}

/** Isolation key: one physical connection per server + credential scope. */
function connKey(serverId: string, ctx: Pick<AuthContext, 'tenantId'>): string {
  return `${serverId}::${ctx.tenantId ?? 'default'}`;
}

export interface McpClientPoolOptions {
  /**
   * Max simultaneously open connections per server record. Beyond this,
   * the least recently used tenant connection is closed (lazy reconnect
   * on next use). Default: 20.
   */
  maxConnectionsPerServer?: number;
  /**
   * Credential resolver for per-tenant credential bindings.
   * When provided, the pool resolves per-tenant auth overrides
   * before creating new connections.
   */
  credentialResolver?: ICredentialResolver;
}

interface PooledConnection {
  transport: McpTransport;
  lastUsedAt: number;
}

export class McpClientPool {
  private readonly connections = new Map<string, PooledConnection>();
  private readonly toolCache = new Map<string, ToolMeta[]>();
  private readonly maxConnectionsPerServer: number;
  private readonly credentialResolver?: ICredentialResolver;

  constructor(
    private readonly factory: TransportFactory,
    options: McpClientPoolOptions = {},
  ) {
    this.maxConnectionsPerServer = options.maxConnectionsPerServer ?? 20;
    this.credentialResolver = options.credentialResolver;
  }

  async syncTools(server: MCPServer, ctx: AuthContext): Promise<ToolMeta[]> {
    const { transport } = await this.getPooled(server, ctx);

    let raw: Awaited<ReturnType<McpTransport['listTools']>>;
    try {
      raw = await transport.listTools();
    } catch (err) {
      this.connections.delete(connKey(server.id, ctx));
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
    ctx: AuthContext,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // validate args against the cached tool schema before forwarding
    const cached = this.toolCache.get(server.id);
    if (cached) {
      const toolMeta = cached.find((t) => t.name === toolName);
      if (toolMeta) {
        validateArgs(toolName, args, toolMeta.inputSchema);
      }
    }

    const { transport } = await this.getPooled(server, ctx);
    return transport.callTool(toolName, args);
  }

  async shutdown(): Promise<void> {
    for (const conn of this.connections.values()) {
      await conn.transport.close().catch(() => undefined);
    }
    this.connections.clear();
  }

  /**
   * Closes the caller-scoped connection and drops its cached tools.
   * Idempotent; other tenants' connections stay untouched.
   */
  async disconnect(serverId: string, ctx: Pick<AuthContext, 'tenantId'>): Promise<void> {
    const key = connKey(serverId, ctx);
    const conn = this.connections.get(key);
    if (conn) {
      await conn.transport.close().catch(() => undefined);
      this.connections.delete(key);
    }
    this.toolCache.delete(serverId);
  }

  /** Admin action: closes every tenant connection of this server. */
  async disconnectAll(serverId: string): Promise<void> {
    const prefix = `${serverId}::`;
    for (const [key, conn] of this.connections.entries()) {
      if (key.startsWith(prefix)) {
        await conn.transport.close().catch(() => undefined);
        this.connections.delete(key);
      }
    }
    this.toolCache.delete(serverId);
  }

  private async getPooled(
    server: MCPServer,
    ctx: AuthContext,
  ): Promise<PooledConnection> {
    const key = connKey(server.id, ctx);

    const existing = this.connections.get(key);
    if (existing) {
      existing.lastUsedAt = this.now(); // touch for LRU
      return existing;
    }

    // enforce per-server limit before spawning a new connection
    this.evictIfNeeded(server.id);

    // resolve per-tenant auth override before connecting
    let authOverride: AuthConfig | undefined;
    if (this.credentialResolver) {
      authOverride = await this.credentialResolver.resolve(server.id, ctx);
    }

    const transport = await this.factory(server, authOverride);
    await transport.connect();

    const pooled: PooledConnection = { transport, lastUsedAt: this.now() };
    this.connections.set(key, pooled);
    return pooled;
  }

  /** Monotonic clock — Date.now() is too coarse for LRU ordering. */
  private now(): number {
    return performance.now();
  }

  /** Closes the LRU connection of this server when at capacity. */
  private evictIfNeeded(serverId: string): void {
    const prefix = `${serverId}::`;
    const siblings = [...this.connections.entries()].filter(([k]) =>
      k.startsWith(prefix),
    );

    if (siblings.length < this.maxConnectionsPerServer) {
      return;
    }

    siblings.sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
    const [evictKey, evictConn] = siblings[0];

    void evictConn.transport.close().catch(() => undefined);
    this.connections.delete(evictKey);
  }
}
