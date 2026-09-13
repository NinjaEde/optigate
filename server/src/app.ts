import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';

import { RegistryService } from './services/registryService.js';
import type {
  ServerRepository,
  AuditSink,
} from './services/registryService.js';
import type { McpClientPool } from './infra/mcp/clientPool.js';
import { encryptSecret } from './infra/secrets/secretVault.js';
import { sanitizeAuthForClient } from './infra/mcp/authHeaders.js';
import { createMcpGateway } from './infra/mcp/gateway.js';
import { ToolIndexReconciler } from './infra/mcp/toolIndexReconciler.js';
import type { ICredentialResolver } from './infra/mcp/credentialResolver.js';
import type { ApiKeyService } from './services/apiKeyService.js';
import type { SettingsService } from './services/settingsService.js';
import { ForbiddenError, NotFoundError, ValidationError } from './services/errors.js';
import type {
  AuthContext,
  MCPServer,
  ToolMeta,
} from './domain/types.js';

export interface AppOptions {
  auth: {
    resolveAuth(request: { headers: Record<string, unknown> }): Promise<AuthContext>;
  };
  registry: {
    repo: ServerRepository;
    audit: AuditSink;
  };
  pool: McpClientPool;
  /** Per-tenant credential bindings (isolation border, see multi-tenancy doc). */
  credentials: ICredentialResolver;
  /** Gateway API key management (gateway-only identities). */
  apiKeys: ApiKeyService;
  /** Runtime-tunable operational settings (DB > env > default). */
  settings: SettingsService;
  /** Static flag or live lookup (runtime settings). */
  approvalRequired: boolean | (() => boolean);
  /** Optional health check that runs on every /health call (e.g. DB ping). */
  healthCheck?: () => Promise<void>;
  /** Comma-separated allowed CORS origins (default: *). */
  corsOrigin?: string;
}

const registerSchema = {
  body: {
    type: 'object',
    required: ['name', 'scope', 'transport', 'connection'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 2000 },
      scope: { enum: ['global', 'tenant', 'private'] },
      /**
       * Only superadmins; stdio servers cannot be shared. Validated in
       * RegistryService.assertShared.
       */
      shared: { type: 'boolean' },
      transport: { enum: ['stdio', 'streamable_http', 'sse'] },
      connection: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          url: { type: 'string' },
          envRefs: { type: 'array', items: { type: 'string' } },
          auth: {
            type: 'object',
            properties: {
              type: {
                enum: ['none', 'bearer', 'api_key', 'custom_headers', 'oauth2'],
              },
              secretRef: { type: 'string' },
              /**
               * Direct secret entry (alternative to secretRef). Accepted as
               * plaintext from the client, encrypted at rest by the backend,
               * never returned in responses.
               */
              secretPlaintext: { type: 'string' },
              headerName: { type: 'string' },
              headerPrefix: { type: 'string' },
              tokenUrl: { type: 'string' },
              clientId: { type: 'string' },
              clientSecretRef: { type: 'string' },
              clientSecretPlaintext: { type: 'string' },
              scopes: { type: 'array', items: { type: 'string' } },
            },
            required: ['type'],
            additionalProperties: false,
          },
          customHeadersEnvRefs: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          customHeaders: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
    },
  },
} as const;

const updateSchema = {
  body: {
    type: 'object',
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 100 },
      description: { type: 'string', maxLength: 2000 },
      transport: { enum: ['stdio', 'streamable_http', 'sse'] },
      connection: registerSchema.body.properties.connection,
    },
    additionalProperties: false,
  },
} as const;

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  const registry = new RegistryService(options.registry.repo, {
    approvalRequired: options.approvalRequired,
    audit: options.registry.audit,
  });

  // ── Global tool index (kept fresh by the reconciler) ──────────────────
  //
  // The reconciler auto-connects all healthy servers on boot (3 retries
  // each) and re-syncs periodically, so search_tools is current without
  // any manual "Verbinden" click. Ad-hoc triggers: registerServer,
  // approveServer, validate and manual refresh below.

  const toolsByServer = new Map<string, ToolMeta[]>();

  const settings = options.settings;
  const toolIndexReconciler = new ToolIndexReconciler(
    {
      allActiveServers: () => options.registry.repo.allActive(),
      // reconciler runs as system process → default credential scope
      syncTools: (server) =>
        options.pool.syncTools(server, {
          userId: 'system',
          role: 'superadmin',
          tenantId: null,
        }),
      onIndexUpdated: (index) => {
        toolsByServer.clear();
        for (const [id, tools] of index) {
          toolsByServer.set(id, tools);
        }
      },
      markStatus: (serverId, status, detail) =>
        registry.markStatus(
          { userId: 'system', role: 'superadmin', tenantId: null },
          serverId,
          status,
          detail,
        ),
    },
    {
      retryDelayMs: () => settings.getCached<number>('reconciler.retryDelayMs'),
      intervalMs: () => settings.getCached<number>('reconciler.intervalMs'),
      maxStaleCycles: () => settings.getCached<number>('reconciler.maxStaleCycles'),
      log: (msg) => app.log.info(`[tool-index] ${msg}`),
    },
  );

  function triggerReconcile() {
    void toolIndexReconciler.reconcileNow().catch(() => undefined);
  }

  await app.register(cors, {
    origin: options.corsOrigin
      ? options.corsOrigin.split(',').map((s) => s.trim())
      : true,
  });

  await app.register(rateLimit, {
    global: true,
    // resolved per request so admins can tune it at runtime
    max: () => settings.getCached<number>('ratelimit.max'),
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      return request.ip;
    },
    errorResponseBuilder: (_request, context) => {
      return {
        statusCode: 429,
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Max ${context.max} requests per ${context.after}`,
      };
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/health') || request.method === 'OPTIONS') {
      return;
    }
    try {
      const auth = await options.auth.resolveAuth(request);
      (request as unknown as { auth: AuthContext }).auth = auth;
      // Gateway-only identities: API keys may use /mcp but never /api.
      if (auth.viaApiKey && request.url.startsWith('/api/')) {
        reply.code(403).send({ error: 'API keys are gateway-only' });
        return;
      }
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
  });

  function getAuth(request: unknown): AuthContext {
    return (request as unknown as { auth: AuthContext }).auth;
  }

  interface IncomingAuth {
    type?: string;
    secretRef?: string;
    secretPlaintext?: string;
    headerName?: string;
    headerPrefix?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecretRef?: string;
    clientSecretPlaintext?: string;
    scopes?: string[];
  }

  /**
   * Converts incoming connection JSON into its stored form:
   * secretPlaintext / clientSecretPlaintext are encrypted at rest;
   * plaintext values never touch the database or responses.
   */
  function processIncomingConnection(connection: Record<string, unknown>) {
    const auth = connection.auth as IncomingAuth | undefined;

    if (!auth) {
      return { ...connection };
    }

    const stored: Record<string, unknown> = { ...auth };

    if (auth.secretPlaintext) {
      const enc = encryptSecret(auth.secretPlaintext);
      if (!enc) {
        throw new Error(
          'Direct secret entry requires SECRET_ENCRYPTION_KEY to be configured',
        );
      }
      stored.secretEnc = enc;
      delete stored.secretPlaintext;
    }

    if (auth.clientSecretPlaintext) {
      const enc = encryptSecret(auth.clientSecretPlaintext);
      if (!enc) {
        throw new Error(
          'Direct secret entry requires SECRET_ENCRYPTION_KEY to be configured',
        );
      }
      stored.clientSecretEnc = enc;
      delete stored.clientSecretPlaintext;
    }

    return { ...connection, auth: stored };
  }

  /**
   * Strips secret material before any server object leaves the backend.
   * Static customHeaders values are masked too — they routinely carry
   * tokens, and every viewer of the server could otherwise read them.
   * The '__stored__' marker round-trips: updateServer keeps the stored
   * value for keys still carrying the marker.
   */
  function toClientResponse(server: MCPServer) {
    const customHeaders = server.connection.customHeaders
      ? Object.fromEntries(
          Object.keys(server.connection.customHeaders).map((k) => [k, '__stored__']),
        )
      : undefined;
    return {
      ...server,
      connection: {
        ...server.connection,
        ...(customHeaders ? { customHeaders } : {}),
        auth: sanitizeAuthForClient(server.connection.auth),
      },
    };
  }

  // ── Health endpoint ──────────────────────────────────────────────────

  app.get('/health', async () => {
    if (typeof options.healthCheck === 'function') {
      await options.healthCheck();
    }
    return { status: 'healthy' };
  });

  // ── Admin: server lifecycle ────────────────────────────────────────────

  app.post(
    '/api/servers',
    { schema: registerSchema },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        description?: string;
        scope: 'global' | 'tenant' | 'private';
        shared?: boolean;
        transport: 'stdio' | 'streamable_http' | 'sse';
        connection: Record<string, never>;
      };

      try {
        const server = await registry.registerServer(getAuth(request), {
          name: body.name,
          description: body.description ?? '',
          scope: body.scope,
          shared: body.shared,
          transport: body.transport,
          connection: processIncomingConnection(
            body.connection,
          ) as unknown as Record<string, never>,
        });
        // new server → index it right away (async, response is not blocked)
        triggerReconcile();
        reply.code(201).send(toClientResponse(server));
      } catch (err) {
        reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get('/api/servers', async (request) => {
    return (await registry.listServersFor(getAuth(request))).map(toClientResponse);
  });

  app.get('/api/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return toClientResponse(
        await registry.getVisibleServer(getAuth(request), id),
      );
    } catch {
      reply.code(404).send({ error: 'Server not found' });
    }
  });

  app.post('/api/servers/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = toClientResponse(
        await registry.approveServer(getAuth(request), id),
      );
      triggerReconcile();
      return result;
    } catch (err) {
      reply.code(403).send({ error: (err as Error).message });
    }
  });

  app.patch(
    '/api/servers/:id',
    { schema: updateSchema },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown>;
      try {
        const patch = { ...body };
        if (typeof patch.connection === 'object' && patch.connection !== null) {
          patch.connection = processIncomingConnection(
            patch.connection as Record<string, unknown>,
          );
        }
        return toClientResponse(
          await registry.updateServer(
            getAuth(request),
            id,
            patch as Record<string, never>,
          ),
        );
      } catch (err) {
        // Policy denials are 403; everything else stays 400 (validation).
        reply
          .code(err instanceof ForbiddenError ? 403 : 400)
          .send({ error: (err as Error).message });
      }
    },
  );

  app.post('/api/servers/:id/disable', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = toClientResponse(
        await registry.disableServer(getAuth(request), id),
      );
      // disabled = out of operation: drop connection + tools immediately.
      // Admin action → drop ALL tenant connections of this server.
      await options.pool.disconnectAll(id);
      toolsByServer.delete(id);
      return result;
    } catch (err) {
      reply.code(403).send({ error: (err as Error).message });
    }
  });

  app.post('/api/servers/:id/enable', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = toClientResponse(
        await registry.enableServer(getAuth(request), id),
      );
      triggerReconcile(); // index the server again right away
      return result;
    } catch (err) {
      reply.code(403).send({ error: (err as Error).message });
    }
  });

  // ── Disconnect: close the pool connection and drop cached tools ───────
  // Superadmin disconnects ALL tenant connections; everyone else only
  // their own tenant scope. Requires manage rights: status and index
  // changes are server-global, not tenant-scoped.
  app.post('/api/servers/:id/disconnect', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const auth = getAuth(request);
      const server = await registry.getManageableServer(auth, id);

      if (auth.role === 'superadmin') {
        await options.pool.disconnectAll(server.id);
      } else {
        await options.pool.disconnect(server.id, auth);
      }
      toolsByServer.delete(server.id);
      await registry.markStatus(
        getAuth(request),
        server.id,
        'offline',
        'disconnected by user',
      );
      triggerReconcile(); // keep reconciler state consistent

      return { disconnected: true, id: server.id, status: 'offline' };
    } catch {
      // Deliberately 404 for policy denials too: must not leak existence.
      reply.code(404).send({ error: 'Server not found' });
    }
  });

  app.delete('/api/servers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await registry.deleteServer(getAuth(request), id);
      await options.pool.disconnectAll(id);
      toolsByServer.delete(id);
      reply.code(204).send();
    } catch {
      // Deliberately 404 for policy denials too: must not leak existence.
      reply.code(404).send({ error: 'Server not found' });
    }
  });

  // ── Tools: sync, search, execute ──────────────────────────────────────

  /**
   * Validates a server: attempts a real connection via the client pool
   * (initialize + tools/list), updates health status accordingly and
   * caches the discovered tools. Returns the tool list on success.
   * Requires manage rights: opens real upstream connections and flips
   * server-global status.
   */
  app.post('/api/servers/:id/validate', async (request, reply) => {
    const { id } = request.params as { id: string };
    let server: MCPServer;

    try {
      server = await registry.getManageableServer(getAuth(request), id);
    } catch (err) {
      if (err instanceof ForbiddenError) {
        reply.code(403).send({ error: (err as Error).message });
        return;
      }
      reply.code(404).send({ error: 'Server not found' });
      return;
    }

    try {
      const tools = await options.pool.syncTools(server, getAuth(request));
      toolsByServer.set(id, tools);

      await registry.markStatus(
        getAuth(request),
        id,
        'healthy',
        `connection ok · ${tools.length} tools`,
      );

      return { valid: true, status: 'healthy', tools };
    } catch (err) {
      const message = (err as Error).message;
      const reachable = false;

      try {
        await registry.markStatus(getAuth(request), id, 'offline', message);
      } catch {
        // status update is best-effort; surface the original error below
      }

      reply.code(502).send({ valid: reachable, status: 'offline', error: message });
    }
  });

  app.post('/api/servers/:id/tools/refresh', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      // Manage rights required: opens a real upstream connection and
      // rewrites the server-global tool index.
      const server = await registry.getManageableServer(getAuth(request), id);
      const tools = await options.pool.syncTools(server, getAuth(request));
      toolsByServer.set(id, tools);
      return { tools };
    } catch (err) {
      if (err instanceof ForbiddenError) {
        reply.code(403).send({ error: (err as Error).message });
        return;
      }
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get('/api/servers/:id/tools', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      await registry.getVisibleServer(getAuth(request), id);
    } catch {
      reply.code(404).send({ error: 'Server not found' });
      return;
    }
    return toolsByServer.get(id) ?? [];
  });

  app.post('/api/tools/search', async (request) => {
    const { query, limit } = (request.body ?? {}) as {
      query?: string;
      limit?: number;
    };

    const provider = async (): Promise<Array<ToolMeta & { serverName: string }>> => {
      const servers = await registry.listServersFor(getAuth(request));
      const nameById = new Map(servers.map((s) => [s.id, s.name]));
      const all: Array<ToolMeta & { serverName: string }> = [];

      for (const s of servers) {
        for (const t of toolsByServer.get(s.id) ?? []) {
          all.push({ ...t, serverName: nameById.get(t.serverId) ?? s.name });
        }
      }
      return all;
    };

    const maxLimit = settings.getCached<number>('search.maxLimit');
    const tools = await registry.searchToolsFor(
      getAuth(request),
      query ?? '',
      Math.min(limit ?? settings.getCached<number>('search.defaultLimit'), maxLimit),
      provider,
    );

    return { tools };
  });

  app.post('/api/tools/execute', async (request, reply) => {
    const { server_id, tool_name, args } = (request.body ?? {}) as {
      server_id?: string;
      tool_name?: string;
      args?: Record<string, unknown>;
    };

    if (!server_id || !tool_name) {
      reply.code(400).send({ error: 'server_id and tool_name are required' });
      return;
    }

    try {
      const server = await registry.getVisibleServer(getAuth(request), server_id);

      if (server.status !== 'healthy') {
        reply.code(409).send({ error: `Server is ${server.status}` });
        return;
      }

      const result = await options.pool.callTool(
        server,
        getAuth(request),
        tool_name,
        args ?? {},
      );

      await options.registry.audit?.record({
        actorId: getAuth(request).userId,
        tenantId: getAuth(request).tenantId,
        action: 'tool.called',
        subjectId: tool_name,
        detail: { serverId: server_id },
      });

      return { result };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  // ── Per-tenant credential bindings ────────────────────────────────────
  //
  // Shared servers are visible platform-wide, but each tenant connects with
  // its own credentials. Rules:
  //   - superadmin may manage bindings for any tenant
  //   - admin may manage bindings ONLY for their own tenant
  //   - secrets are stored encrypted (secretPlaintext → secretEnc) and
  //     never returned to clients; only secretRef names are visible.

  interface IncomingBinding {
    auth?: {
      type?: string;
      secretRef?: string;
      secretPlaintext?: string;
      headerName?: string;
    };
  }

  app.get('/api/servers/:id/bindings', async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = getAuth(request);

    try {
      await registry.getVisibleServer(auth, id);

      if (auth.role !== 'superadmin' && auth.role !== 'admin') {
        reply.code(403).send({ error: 'Only admins may view credential bindings' });
        return;
      }

      const rawBindings = await options.credentials.listBindings(id);
      // Tenant isolation: non-superadmins only see their own tenant's
      // binding plus the platform default — never other tenants' refs.
      const scoped =
        auth.role === 'superadmin'
          ? rawBindings
          : rawBindings.filter(
              (b) => b.tenantId === null || b.tenantId === auth.tenantId,
            );
      const bindings = scoped.map((b) => ({
        serverId: b.serverId,
        tenantId: b.tenantId,
        isDefault: b.tenantId === null,
        authType: b.auth.type,
        secretRef: b.auth.secretRef ?? null,
        // never expose secretEnc / plaintext values
      }));
      return { bindings };
    } catch (err) {
      reply.code(404).send({ error: (err as Error).message });
    }
  });

  app.put('/api/servers/:id/bindings/:tenantId', async (request, reply) => {
    const { id } = request.params as { id: string };
    // "default" in the URL maps to the null default binding
    const rawTenant = (request.params as { tenantId: string }).tenantId;
    const tenantId = rawTenant === 'default' ? null : rawTenant;
    const auth = getAuth(request);
    const body = request.body as IncomingBinding | undefined;

    if (!body?.auth?.type) {
      reply.code(400).send({ error: 'auth object with a type is required' });
      return;
    }

    if (auth.role === 'admin' && auth.tenantId !== tenantId) {
      reply.code(403).send({
        error: 'Admins may only manage bindings for their own tenant',
      });
      return;
    }
    if (auth.role !== 'superadmin' && auth.role !== 'admin') {
      reply.code(403).send({ error: 'Only admins may manage credential bindings' });
      return;
    }

    try {
      const incoming = body.auth as Record<string, unknown>;
      const stored: Record<string, unknown> = { type: incoming.type };

      if (incoming.secretPlaintext) {
        const enc = encryptSecret(String(incoming.secretPlaintext));
        if (!enc) {
          throw new Error(
            'Direct secret entry requires SECRET_ENCRYPTION_KEY to be configured',
          );
        }
        stored.secretEnc = enc;
      } else if (incoming.secretRef) {
        stored.secretRef = incoming.secretRef;
      }
      if (typeof incoming.headerName === 'string') {
        stored.headerName = incoming.headerName;
      }

      options.credentials.setBinding(id, tenantId || null, stored as never);
      triggerReconcile();

      reply.code(201).send({
        serverId: id,
        tenantId: tenantId || null,
        authType: incoming.type,
        secretRef: incoming.secretRef ?? null,
      });
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/servers/:id/bindings/:tenantId', async (request, reply) => {
    const { id, tenantId } = request.params as { id: string; tenantId: string };
    const auth = getAuth(request);

    if (auth.role !== 'superadmin') {
      reply.code(403).send({ error: 'Only superadmins may delete bindings' });
      return;
    }

    const deleted = options.credentials.deleteBinding(id, tenantId || null);
    if (!deleted) {
      reply.code(404).send({ error: 'No such binding' });
      return;
    }
    reply.code(204).send();
  });

  // ── Audit feed ────────────────────────────────────────────────────────

  // ── Own identity (lets the UI gate admin-only views) ────────────────
  app.get('/api/whoami', async (request) => {
    const auth = getAuth(request);
    return { userId: auth.userId, role: auth.role, tenantId: auth.tenantId };
  });

  app.get('/api/audit', async (request) => {
    const auth = getAuth(request);
    return typeof options.registry.audit.recent === 'function'
      ? options.registry.audit.recent(
          settings.getCached<number>('audit.limit'),
          auth.role === 'superadmin' ? undefined : auth.tenantId,
        )
      : [];
  });

  // ── Gateway API keys ────────────────────────────────────────────────
  //
  // Keys grant gateway-only access (/mcp search/execute): the onRequest
  // hook above rejects key identities on every /api route, and keys can
  // never create new keys. Admins manage keys of their own tenant,
  // superadmins manage all. The plaintext secret is returned exactly
  // once at creation; only the hash is stored.

  const apiKeySchema = {
    body: {
      type: 'object',
      required: ['name', 'role'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        role: { enum: ['superadmin', 'admin', 'user'] },
        tenantId: { type: 'string' },
        expiresAt: { type: 'string' },
      },
      additionalProperties: false,
    },
  } as const;

  app.post(
    '/api/api-keys',
    { schema: apiKeySchema },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        role: AuthContext['role'];
        tenantId?: string;
        expiresAt?: string;
      };
      try {
        const result = await options.apiKeys.createKey(getAuth(request), {
          name: body.name,
          role: body.role,
          tenantId: body.tenantId ?? null,
          expiresAt: body.expiresAt ?? null,
        });
        reply.code(201).send(result);
      } catch (err) {
        reply.code(403).send({ error: (err as Error).message });
      }
    },
  );

  app.get('/api/api-keys', async (request, reply) => {
    try {
      return { keys: await options.apiKeys.listKeys(getAuth(request)) };
    } catch (err) {
      reply.code(403).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/api-keys/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await options.apiKeys.revokeKey(getAuth(request), id);
    } catch (err) {
      reply
        .code(err instanceof NotFoundError ? 404 : 403)
        .send({ error: (err as Error).message });
    }
  });

  // ── Runtime settings ────────────────────────────────────────────────
  //
  // Operational tuning knobs (DB override > env var > built-in default).
  // Reading and writing requires admin rights; security-sensitive keys
  // (ssrf.*, approval) additionally require superadmin (enforced in the
  // service). Every change is audited as setting.changed.

  app.get('/api/settings', async (request, reply) => {
    const auth = getAuth(request);
    if (auth.role !== 'superadmin' && auth.role !== 'admin') {
      reply.code(403).send({ error: 'Only admins may view settings' });
      return;
    }
    return { settings: await options.settings.list() };
  });

  app.put(
    '/api/settings/:key',
    {
      schema: {
        body: {
          type: 'object',
          required: ['value'],
          properties: { value: {} },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const { value } = request.body as { value: unknown };
      try {
        return await options.settings.set(getAuth(request), key, value);
      } catch (err) {
        reply
          .code(
            err instanceof NotFoundError
              ? 404
              : err instanceof ValidationError
                ? 400
                : 403,
          )
          .send({ error: (err as Error).message });
      }
    },
  );

  app.delete('/api/settings/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    try {
      return await options.settings.reset(getAuth(request), key);
    } catch (err) {
      reply
        .code(
          err instanceof NotFoundError
            ? 404
            : err instanceof ValidationError
              ? 400
              : 403,
        )
        .send({ error: (err as Error).message });
    }
  });

  // ── MCP facade (/mcp): the registry itself as an MCP server ───────────
  //
  // Exposes exactly two meta tools (search_tools, execute_tool) over
  // Streamable HTTP in stateless JSON mode, so any MCP client (Hermes,
  // Claude, …) can consume every visible registry server through a single
  // endpoint without any intermediary backend.

  const buildGatewayToolIndex = async (
    _auth: AuthContext,
    servers: MCPServer[],
  ): Promise<Array<ToolMeta & { serverName: string }>> => {
    const nameById = new Map(servers.map((s) => [s.id, s.name]));
    const all: Array<ToolMeta & { serverName: string }> = [];

    for (const s of servers) {
      for (const t of toolsByServer.get(s.id) ?? []) {
        all.push({ ...t, serverName: nameById.get(t.serverId) ?? s.name });
      }
    }
    return all;
  };

  const gateway = createMcpGateway({
    resolveAuth: (request) => options.auth.resolveAuth(request),
    dispatchTimeoutMs: () => settings.getCached<number>('gateway.dispatchTimeoutMs'),
    searchDefaultLimit: () => settings.getCached<number>('search.defaultLimit'),
    searchMaxLimit: () => settings.getCached<number>('search.maxLimit'),
    listVisibleServers: (auth) => registry.listServersFor(auth),
    buildToolIndex: buildGatewayToolIndex,
    searchTools: async (tools, query, limit) => {
      const { searchTools } = await import('./domain/toolSearch.js');
      return searchTools(tools, query, limit);
    },
    callTool: async (server, auth, toolName, args) => {
      const result = await options.pool.callTool(server, auth, toolName, args);
      await options.registry.audit?.record({
        actorId: auth.userId,
        tenantId: auth.tenantId,
        action: 'tool.called',
        subjectId: toolName,
        detail: { serverId: server.id },
      });
      return result;
    },
  });

  app.post('/mcp', async (request, reply) => {
    const body = request.body as Parameters<
      typeof gateway.handleGatewayPost
    >[1];

    const { status, body: responseBody } = await gateway.handleGatewayPost(
      request.headers as Record<string, unknown>,
      body ?? {},
    );

    reply.code(status).send(responseBody);
  });

  app.get(
    '/mcp',
    {
      schema: {
        response: {
          405: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    (_request, reply) => {
      // stateless mode: no server-initiated SSE streams
      reply.code(405).send({ error: 'SSE streaming not supported; use POST' });
    },
  );

  app.delete('/mcp', (_request, reply) => {
    reply.code(405).send({ error: 'Stateless mode: nothing to terminate' });
  });

  // ── Tool index reconciler ─────────────────────────────────────────────
  //
  // Auto-connects all healthy servers at boot (3 retries each) and keeps
  // the index current via a periodic loop; register/approve trigger an
  // immediate re-reconcile. Stopped with the server.

  toolIndexReconciler.start();
  app.addHook('onClose', async () => {
    await toolIndexReconciler.stop();
    await options.pool.shutdown();
  });

  return app;
}
