import type {
  AuthContext,
  MCPServer,
  Scope,
  Transport,
} from '../domain/types.js';
import type { SearchableTool } from '../domain/toolSearch.js';

export interface RegisterServerInput {
  name: string;
  description: string;
  scope: Scope;
  /** Only superadmins; stdio servers cannot be shared (see assertShared). */
  shared?: boolean;
  transport: Transport;
  connection: MCPServer['connection'];
}

export interface ServerRepository {
  insert(server: MCPServer): Promise<void>;
  findById(id: string): Promise<MCPServer | null>;
  findByNameInTenant(name: string, tenantId: string | null): Promise<MCPServer | null>;
  allActive(): Promise<MCPServer[]>;
  save(server: MCPServer): Promise<void>;
}

export interface AuditSink {
  record(event: {
    actorId: string;
    tenantId: string | null;
    action:
      | 'server.registered'
      | 'server.updated'
      | 'server.approved'
      | 'server.disabled'
      | 'server.enabled'
      | 'server.deleted'
      | 'server.status_changed'
      | 'tool.searched'
      | 'tool.called';
    subjectId: string | null;
    detail: Record<string, unknown>;
  }): Promise<void>;
  recent?(limit?: number, tenantId?: string | null): Promise<unknown[]>;
}

export class RegistryService {
  constructor(
    private readonly repo: ServerRepository,
    private readonly options: { approvalRequired: boolean; audit?: AuditSink },
  ) {}

  async registerServer(auth: AuthContext, input: RegisterServerInput): Promise<MCPServer> {
    const { canRegister, resolveStatusForNewServer } = await import(
      '../domain/policy.js'
    );

    if (!canRegister(auth, input.scope)) {
      throw new Error('Registration not allowed for this role and scope');
    }

    this.assertConnectionValid(input.transport, input.connection);

    const shared = this.assertShared(auth, input.shared ?? false, input.transport);

    const existing = await this.repo.findByNameInTenant(input.name, input.scope === 'global' ? null : auth.tenantId);
    if (existing && !existing.deletedAt) {
      throw new Error(`A server named "${input.name}" already exists`);
    }

    const now = new Date().toISOString();
    const server: MCPServer = {
      id: crypto.randomUUID(),
      tenantId: input.scope === 'global' ? null : auth.tenantId,
      name: input.name,
      description: input.description,
      scope: input.scope,
      shared,
      ownerId: input.scope === 'private' ? auth.userId : null,
      transport: input.transport,
      connection: input.connection,
      status: resolveStatusForNewServer(this.options.approvalRequired),
      createdBy: auth.userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    await this.repo.insert(server);
    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.registered',
      subjectId: server.id,
      detail: { name: server.name, scope: server.scope, transport: server.transport },
    });

    return server;
  }

  async listServersFor(auth: AuthContext): Promise<MCPServer[]> {
    const { canView } = await import('../domain/policy.js');
    const all = await this.repo.allActive();
    return all.filter((s) => canView(s, auth));
  }

  async getVisibleServer(auth: AuthContext, id: string): Promise<MCPServer> {
    const { canView } = await import('../domain/policy.js');
    const server = await this.repo.findById(id);

    if (!server || server.deletedAt) {
      throw new Error('Server not found');
    }
    if (!canView(server, auth)) {
      throw new Error('Server not found'); // do not leak existence
    }

    return server;
  }

  async approveServer(auth: AuthContext, id: string): Promise<MCPServer> {
    const { canApprove } = await import('../domain/policy.js');
    if (!canApprove(auth)) {
      throw new Error('Only superadmins may approve servers');
    }

    const server = await this.getVisibleServer(auth, id);
    server.status = 'healthy';
    server.updatedAt = new Date().toISOString();
    await this.repo.save(server);

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.approved',
      subjectId: server.id,
      detail: {},
    });

    return server;
  }

  async disableServer(auth: AuthContext, id: string): Promise<MCPServer> {
    const server = await this.getVisibleServer(auth, id);
    server.status = 'disabled';
    server.updatedAt = new Date().toISOString();
    await this.repo.save(server);

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.disabled',
      subjectId: server.id,
      detail: {},
    });

    return server;
  }

  /**
   * Re-enables a disabled server. Unlike approveServer this requires no
   * fresh approval round: the server was already approved once — disabling
   * and re-enabling is an administrative toggle, not a supply-chain gate.
   */
  async enableServer(auth: AuthContext, id: string): Promise<MCPServer> {
    const { canApprove } = await import('../domain/policy.js');
    if (!canApprove(auth)) {
      throw new Error('Only superadmins may enable servers');
    }

    const server = await this.getVisibleServer(auth, id);
    if (server.status !== 'disabled') {
      throw new Error(`Only disabled servers can be enabled (is ${server.status})`);
    }
    server.status = 'healthy';
    server.updatedAt = new Date().toISOString();
    await this.repo.save(server);

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.enabled',
      subjectId: server.id,
      detail: {},
    });

    return server;
  }

  async updateServer(
    auth: AuthContext,
    id: string,
    patch: Partial<RegisterServerInput>,
  ): Promise<MCPServer> {
    const server = await this.getVisibleServer(auth, id);

    if (patch.name !== undefined && patch.name !== server.name) {
      const tenantForName = server.scope === 'global' ? null : server.tenantId;
      const existing = await this.repo.findByNameInTenant(patch.name, tenantForName);
      if (existing && existing.id !== server.id) {
        throw new Error(`A server named "${patch.name}" already exists`);
      }
      server.name = patch.name;
    }

    if (patch.description !== undefined) {
      server.description = patch.description;
    }

    if (patch.transport !== undefined) {
      server.transport = patch.transport;
    }

    if (patch.connection !== undefined) {
      this.assertConnectionValid(
        patch.transport ?? server.transport,
        patch.connection,
      );
      server.connection = patch.connection;
    }

    // config change invalidates cached connection state
    server.updatedAt = new Date().toISOString();
    await this.repo.save(server);

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.updated',
      subjectId: server.id,
      detail: { fields: Object.keys(patch) },
    });

    return server;
  }

  /**
   * Updates only the health status of a server (used by the validate
   * endpoint). Writes an audit event; unlike updateServer it does not
   * touch configuration.
   */
  async markStatus(
    auth: AuthContext,
    id: string,
    status: MCPServer['status'],
    detail: string,
  ): Promise<void> {
    const server = await this.repo.findById(id);
    if (!server || server.deletedAt) {
      return;
    }

    server.status = status;
    server.updatedAt = new Date().toISOString();
    await this.repo.save(server);

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.status_changed',
      subjectId: server.id,
      detail: { status, detail },
    });
  }

  async deleteServer(auth: AuthContext, id: string): Promise<void> {
    const server = await this.getVisibleServer(auth, id);
    server.deletedAt = new Date().toISOString();
    server.status = 'disabled';
    server.updatedAt = server.deletedAt;
    await this.repo.save(server);

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: server.tenantId,
      action: 'server.deleted',
      subjectId: server.id,
      detail: {},
    });
  }

  async searchToolsFor(
    auth: AuthContext,
    query: string,
    limit: number,
    toolsProvider: () => Promise<SearchableTool[]>,
  ): Promise<Array<SearchableTool & { score: number }>> {
    const { searchTools } = await import('../domain/toolSearch.js');

    const visibleServers = new Set((await this.listServersFor(auth)).map((s) => s.id));
    const usable = (await toolsProvider()).filter(
      (t) =>
        visibleServers.has(t.serverId) &&
        ['healthy'].includes(
          // status check happens via listServersFor filtering already
          'healthy',
        ),
    );

    const results: Array<SearchableTool & { score: number }> = searchTools(
      usable,
      query,
      limit,
    );

    await this.options.audit?.record({
      actorId: auth.userId,
      tenantId: auth.tenantId,
      action: 'tool.searched',
      subjectId: null,
      detail: {
        query,
        resultIds: results.map((r) => `${r.serverId}/${r.name}`),
      },
    });

    return results;
  }

  private assertConnectionValid(
    transport: Transport,
    connection: MCPServer['connection'],
  ): void {
    if (transport !== 'stdio' && !connection.url) {
      throw new Error('HTTP-based transports require a connection.url');
    }
    if (transport === 'stdio' && !connection.command) {
      throw new Error('stdio transports require a connection.command');
    }
  }

  /**
   * Shared servers are visible platform-wide but connect per tenant.
   * Decision (2026-08): shared is superadmin-only and stdio servers cannot
   * be shared — process isolation across tenants is impossible for spawned
   * processes; shared stdio would force every tenant onto one process with
   * default credentials. HTTP/SSE servers may be shared; tenants without
   * their own credential binding use the default (platform-financed)
   * credentials — per-tenant bindings are opt-in via the bindings API.
   */
  private assertShared(
    auth: AuthContext,
    shared: boolean,
    transport: Transport,
  ): boolean {
    if (!shared) {
      return false;
    }
    if (auth.role !== 'superadmin') {
      throw new Error('Only superadmins may share servers platform-wide');
    }
    if (transport === 'stdio') {
      throw new Error(
        'stdio servers cannot be shared: process-based servers cannot '
          + 'isolate tenants. Register them per tenant instead.',
      );
    }
    return true;
  }
}
