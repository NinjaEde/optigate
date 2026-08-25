import type { AuthContext, MCPServer, ServerStatus, Scope } from './types.js';

/** Can the authenticated user see this server at all? */
export function canView(server: MCPServer, auth: AuthContext): boolean {
  if (auth.role === 'superadmin') {
    return true;
  }

  // shared servers are visible platform-wide (credentials stay per-tenant)
  if (server.shared) {
    return true;
  }

  switch (server.scope) {
    case 'global':
      return true;

    case 'tenant': {
      if (!server.tenantId || !auth.tenantId) {
        return false;
      }
      return server.tenantId === auth.tenantId;
    }

    case 'private':
      return server.ownerId === auth.userId;

    default:
      return false;
  }
}

/** May the user register servers with this scope? */
export function canRegister(auth: AuthContext, scope: Scope): boolean {
  if (scope === 'global') {
    return auth.role === 'superadmin';
  }

  // tenant / private registration requires admin rights within a tenant
  return auth.role === 'superadmin' || auth.role === 'admin';
}

/** Only superadmins approve new servers (supply-chain gate). */
export function canApprove(auth: AuthContext): boolean {
  return auth.role === 'superadmin';
}

export function resolveStatusForNewServer(approvalRequired: boolean): ServerStatus {
  return approvalRequired ? 'pending_approval' : 'healthy';
}
