import type { AuthConfig, AuthContext } from '../../domain/types.js';

export interface CredentialBinding {
  serverId: string;
  /** null = default/fallback binding */
  tenantId: string | null;
  auth: AuthConfig;
}

/**
 * Interface for credential resolution.
 *
 * Precedence:
 *   1. exact tenant binding
 *   2. default binding (tenantId = null)
 *   3. undefined → caller falls back to the inline server connection auth
 */
export interface ICredentialResolver {
  setBinding(
    serverId: string,
    tenantId: string | null,
    auth: AuthConfig,
  ): Promise<void> | void;
  deleteBinding(serverId: string, tenantId: string | null): Promise<boolean> | boolean;
  listBindings(
    serverId: string,
  ): CredentialBinding[] | Promise<CredentialBinding[]>;
  resolve(
    serverId: string,
    ctx: Pick<AuthContext, 'tenantId'>,
  ): AuthConfig | undefined | Promise<AuthConfig | undefined>;
}

/**
 * In-memory credential binding resolver (dev/test default).
 */
export class InMemoryCredentialResolver implements ICredentialResolver {
  private readonly bindings = new Map<string, CredentialBinding>();

  private static key(serverId: string, tenantId: string | null): string {
    return `${serverId}::${tenantId ?? 'default'}`;
  }

  setBinding(
    serverId: string,
    tenantId: string | null,
    auth: AuthConfig,
  ): void {
    this.bindings.set(InMemoryCredentialResolver.key(serverId, tenantId), {
      serverId,
      tenantId,
      auth,
    });
  }

  deleteBinding(serverId: string, tenantId: string | null): boolean {
    return this.bindings.delete(InMemoryCredentialResolver.key(serverId, tenantId));
  }

  listBindings(serverId: string): CredentialBinding[] {
    return [...this.bindings.values()].filter((b) => b.serverId === serverId);
  }

  resolve(serverId: string, ctx: Pick<AuthContext, 'tenantId'>): AuthConfig | undefined {
    if (ctx.tenantId) {
      const exact = this.bindings.get(
        InMemoryCredentialResolver.key(serverId, ctx.tenantId),
      );
      if (exact) {
        return exact.auth;
      }
    }
    return this.bindings.get(InMemoryCredentialResolver.key(serverId, null))?.auth;
  }
}

/** Kept for backward compat — maps to InMemoryCredentialResolver for simplified use. */
export class CredentialResolver extends InMemoryCredentialResolver {}