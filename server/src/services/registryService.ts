import type {
  AuthContext,
  MCPServer,
  Scope,
  Transport,
} from '../domain/types.js';
import type { SearchableTool } from '../domain/toolSearch.js';
import { ForbiddenError } from './errors.js';

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
      | 'tool.called'
      | 'apikey.created'
      | 'apikey.revoked';
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
    this.assertStdioAllowed(auth, input.transport, true);

    const shared = this.assertShared(auth, input.shared ?? false, input.transport);

    // A non-shared tenant server stamped with a null tenant would be
    // invisible to everyone (including its creator). Shared servers are
    // visible platform-wide, so they are exempt.
    if (input.scope === 'tenant' && !shared && !auth.tenantId) {
      throw new Error(
        'Tenant-scoped registration requires an identity with a tenant',
      );
    }

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

  /**
   * Like getVisibleServer, but additionally requires manage rights
   * (canManage). Used by endpoints with side effects on the server or its
   * upstream connections (update/delete/disable go through the dedicated
   * methods; validate/refresh/disconnect call this directly).
   */
  async getManageableServer(auth: AuthContext, id: string): Promise<MCPServer> {
    const { canManage } = await import('../domain/policy.js');
    const server = await this.getVisibleServer(auth, id);
    if (!canManage(auth, server)) {
      throw new ForbiddenError('Only admins of this server may manage it');
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
    const { canManage } = await import('../domain/policy.js');
    if (!canManage(auth, server)) {
      throw new ForbiddenError('Only admins of this server may disable it');
    }
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

    const { canManage } = await import('../domain/policy.js');
    if (!canManage(auth, server)) {
      throw new ForbiddenError('Only admins of this server may update it');
    }

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
      this.assertStdioAllowed(auth, patch.transport, server.transport !== 'stdio');
      server.transport = patch.transport;
    } else if (server.transport === 'stdio' && patch.connection !== undefined) {
      // Reconfiguring the spawned process of an existing stdio server.
      this.assertStdioAllowed(auth, 'stdio', true);
    }

    if (patch.connection !== undefined) {
      this.assertConnectionValid(
        patch.transport ?? server.transport,
        patch.connection,
      );
      server.connection = this.mergeConnection(
        server.connection,
        patch.connection,
      );
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
    const { canManage } = await import('../domain/policy.js');
    if (!canManage(auth, server)) {
      // Still surfaced as 404 by the handler: must not leak existence.
      throw new ForbiddenError('Only admins of this server may delete it');
    }
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

    // Only tools of visible AND healthy servers are searchable: tool
    // metadata of disabled/offline/pending servers must not leak.
    // (Execution additionally re-checks status per call.)
    const healthyServers = new Set(
      (await this.listServersFor(auth))
        .filter((s) => s.status === 'healthy')
        .map((s) => s.id),
    );
    const usable = (await toolsProvider()).filter((t) =>
      healthyServers.has(t.serverId),
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

  /**
   * Merges a connection patch into the stored connection without losing
   * secrets: clients only ever see the '__stored__' marker, so absent or
   * marker-carrying fields keep their stored values. Explicitly supplied
   * secrets/refs replace the stored ones (stale counterparts are dropped
   * so resolution order stays unambiguous).
   */
  private mergeConnection(
    existing: MCPServer['connection'],
    patch: MCPServer['connection'],
  ): MCPServer['connection'] {
    const merged: MCPServer['connection'] = { ...existing, ...patch };

    if (patch.auth) {
      const auth = { ...existing.auth, ...patch.auth };
      if (patch.auth.secretEnc && !patch.auth.secretRef) {
        delete auth.secretRef;
      }
      if (patch.auth.secretRef && !patch.auth.secretEnc) {
        delete auth.secretEnc;
      }
      if (patch.auth.clientSecretEnc && !patch.auth.clientSecretRef) {
        delete auth.clientSecretRef;
      }
      if (patch.auth.clientSecretRef && !patch.auth.clientSecretEnc) {
        delete auth.clientSecretEnc;
      }
      if (patch.auth.type === 'none') {
        delete auth.secretEnc;
        delete auth.secretRef;
        delete auth.clientSecretEnc;
        delete auth.clientSecretRef;
      }
      merged.auth = auth;
    }

    if (patch.customHeaders && existing.customHeaders) {
      const headers = { ...patch.customHeaders };
      for (const [k, v] of Object.entries(headers)) {
        if (v === '__stored__' && existing.customHeaders[k] !== undefined) {
          headers[k] = existing.customHeaders[k] as string;
        }
      }
      merged.customHeaders = headers;
    }

    return merged;
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
   * stdio servers spawn OS processes with the server's privileges.
   * Only superadmins may introduce or reconfigure such processes —
   * tenant admins are limited to metadata edits on existing ones.
   */
  private assertStdioAllowed(
    auth: AuthContext,
    transport: Transport,
    newProcess: boolean,
  ): void {
    if (transport === 'stdio' && newProcess && auth.role !== 'superadmin') {
      throw new ForbiddenError(
        'Only superadmins may create or reconfigure stdio (process-spawning) servers',
      );
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
