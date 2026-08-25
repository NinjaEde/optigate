import type { AuthConfig, AuthContext } from '../../domain/types.js';

export interface CredentialBinding {
  serverId: string;
  /** null = default/fallback binding */
  tenantId: string | null;
  auth: AuthConfig;
}

/**
 * Resolves which credentials to use for a (server, caller) pair.
 *
 * Precedence:
 *   1. exact tenant binding
 *   2. default binding (tenantId = null)
 *   3. undefined → caller falls back to the inline server connection auth
 *
 * This is the in-memory implementation used in dev/tests; the Postgres
 * variant persists the same shape encrypted at rest.
 *
 * Isolation rationale: statelessness of upstream MCP servers does NOT
 * isolate callers — authorization happens per request via the credentials
 * OptiGate injects. Per-tenant bindings are therefore the isolation border.
 */
export class CredentialResolver {
  private readonly bindings = new Map<string, CredentialBinding>();

  private static key(serverId: string, tenantId: string | null): string {
    return `${serverId}::${tenantId ?? 'default'}`;
  }

  setBinding(
    serverId: string,
    tenantId: string | null,
    auth: AuthConfig,
  ): void {
    this.bindings.set(CredentialResolver.key(serverId, tenantId), {
      serverId,
      tenantId,
      auth,
    });
  }

  deleteBinding(serverId: string, tenantId: string | null): boolean {
    return this.bindings.delete(CredentialResolver.key(serverId, tenantId));
  }

  listBindings(serverId: string): CredentialBinding[] {
    return [...this.bindings.values()].filter((b) => b.serverId === serverId);
  }

  /**
   * Resolves the credential config for the calling context's tenant scope.
   * A caller without tenant uses/gets the default binding.
   */
  resolve(serverId: string, ctx: Pick<AuthContext, 'tenantId'>): AuthConfig | undefined {
    if (ctx.tenantId) {
      const exact = this.bindings.get(
        CredentialResolver.key(serverId, ctx.tenantId),
      );
      if (exact) {
        return exact.auth;
      }
    }
    return this.bindings.get(CredentialResolver.key(serverId, null))?.auth;
  }
}
