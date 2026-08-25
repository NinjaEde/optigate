/**
 * Domain types for OptiGate (MCP gateway & registry).
 *
 * These are pure data contracts — no IO, no framework imports — so the
 * domain logic can be tested in isolation (TDD).
 */

export type Scope = 'global' | 'tenant' | 'private';

export type Transport = 'stdio' | 'streamable_http' | 'sse';

export type ServerStatus =
  | 'pending_approval'
  | 'healthy'
  | 'degraded'
  | 'offline'
  | 'disabled';

export type AuthType = 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2';

export interface AuthConfig {
  type: AuthType;
  /**
   * Secret by reference: env/broker variable name. Either secretRef or
   * secretEnc must be set when the auth type requires a secret.
   */
  secretRef?: string;
  /**
   * Secret by value, encrypted at rest (AES-256-GCM, SECRET_ENCRYPTION_KEY).
   * Never returned to clients in plaintext.
   */
  secretEnc?: string;
  /** api_key only: header to carry the key (default: x-api-key) */
  headerName?: string;
  /** bearer only: prefix before the token (default: Bearer) */
  headerPrefix?: string;
  /** oauth2 client-credentials */
  tokenUrl?: string;
  clientId?: string;
  clientSecretRef?: string;
  /** oauth2 only: client secret by value, encrypted at rest */
  clientSecretEnc?: string;
  scopes?: string[];
}

export interface ConnectionConfig {
  /** stdio only: executable to spawn */
  command?: string;
  /** stdio only: process arguments */
  args?: string[];
  /** http/sse only: base url of the MCP endpoint */
  url?: string;
  /**
   * Environment variable NAMES holding secrets (never the values themselves).
   * Resolved at connect time from the process environment or a broker.
   */
  envRefs?: string[];
  /** Per-server authentication profile */
  auth?: AuthConfig;
  /** Additional static headers resolved from env refs at connect time */
  customHeadersEnvRefs?: Record<string, string>;
  /**
   * Static headers applied on every request, independent of the auth
   * profile. Key = header name, value = literal header value.
   */
  customHeaders?: Record<string, string>;
}


export interface ToolMeta {
  serverId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  lastSeenAt: string;
}

export interface MCPServer {
  id: string;
  tenantId: string | null;
  name: string;
  description: string;
  scope: Scope;
  /**
   * Shared server: visible to ALL tenants (like global), but every tenant
   * connects with its own credential binding. Only superadmins may set
   * this. stdio servers cannot be shared (process isolation impossible);
   * shared servers use the default credential scope.
   */
  shared: boolean;
  ownerId: string | null;
  transport: Transport;
  connection: ConnectionConfig;
  status: ServerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface AuditEvent {
  id: string;
  at: string;
  actorId: string;
  tenantId: string | null;
  action:
    | 'server.registered'
    | 'server.updated'
    | 'server.approved'
    | 'server.disabled'
    | 'server.deleted'
    | 'server.status_changed'
    | 'tool.searched'
    | 'tool.called';
  subjectId: string | null;
  detail: Record<string, unknown>;
}

export interface AuthContext {
  userId: string;
  role: 'superadmin' | 'admin' | 'user';
  tenantId: string | null;
}
