export type Scope = 'global' | 'tenant' | 'private';
export type Transport = 'stdio' | 'streamable_http' | 'sse';
export type ServerStatus =
  | 'pending_approval'
  | 'healthy'
  | 'degraded'
  | 'offline'
  | 'disabled';

export interface AuthConfig {
  type: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2';
  secretRef?: string;
  headerName?: string;
  headerPrefix?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecretRef?: string;
  scopes?: string[];
}

export interface ConnectionConfig {
  command?: string;
  args?: string[];
  url?: string;
  envRefs?: string[];
  auth?: AuthConfig;
  customHeadersEnvRefs?: Record<string, string>;
  /** Static key/value headers, independent of the auth method (0..n entries). */
  customHeaders?: Record<string, string>;
}

export interface MCPServer {
  id: string;
  tenantId: string | null;
  name: string;
  description: string;
  scope: Scope;
  ownerId: string | null;
  transport: Transport;
  connection: ConnectionConfig;
  status: ServerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ToolMeta {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  lastSeenAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  tenantId: string | null;
  action: string;
  subjectId: string | null;
  detail: Record<string, unknown>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // POST/PATCH without payload must not advertise a JSON body,
  // otherwise Fastify rejects the empty body with FST_ERR_CTP_EMPTY_JSON_BODY.
  const hasBody = init?.body !== undefined;
  const headers: Record<string, string> = {
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? 'Request failed');
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  listServers: () => request<MCPServer[]>('/servers'),
  registerServer: (payload: {
    name: string;
    description: string;
    scope: Scope;
    transport: Transport;
    connection: ConnectionConfig;
  }) =>
    request<MCPServer>('/servers', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateServer: (
    id: string,
    payload: {
      name?: string;
      description?: string;
      transport?: Transport;
      connection?: ConnectionConfig;
    },
  ) =>
    request<MCPServer>(`/servers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  approveServer: (id: string) =>
    request<MCPServer>(`/servers/${id}/approve`, { method: 'POST' }),
  enableServer: (id: string) =>
    request<MCPServer>(`/servers/${id}/enable`, { method: 'POST' }),
  disconnectServer: (id: string) =>
    request<{ disconnected: boolean; id: string; status: string }>(
      `/servers/${id}/disconnect`,
      { method: 'POST' },
    ),
  validateServer: (id: string) =>
    request<{ valid: boolean; status: string; tools: ToolMeta[]; error?: string }>(
      `/servers/${id}/validate`,
      { method: 'POST' },
    ),
  disableServer: (id: string) =>
    request<MCPServer>(`/servers/${id}/disable`, { method: 'POST' }),
  deleteServer: (id: string) =>
    request<void>(`/servers/${id}`, { method: 'DELETE' }),
  refreshTools: (id: string) =>
    request<{ tools: ToolMeta[] }>(`/servers/${id}/tools/refresh`, { method: 'POST' }),
  getTools: (id: string) => request<ToolMeta[]>(`/servers/${id}/tools`),
  audit: () => request<AuditEvent[]>('/audit'),
  /** Same retrieval path as the MCP facade's search_tools meta-tool. */
  searchTools: (query: string, limit: number) =>
    request<{
      tools: Array<
        ToolMeta & { serverName: string; serverId: string; score: number }
      >;
    }>('/tools/search', {
      method: 'POST',
      body: JSON.stringify({ query, limit }),
    }),
};
