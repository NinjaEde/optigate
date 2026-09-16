import type { AuthContext, LocalUser } from '../domain/types.js';
import type { AuditSink } from './registryService.js';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js';
import {
  hashPassword,
  normalizeUsername,
  verifyPassword,
} from '../infra/auth/local.js';
import { sanitizeTenantId } from '../infra/auth/keycloak.js';

export const LOCAL_MIN_PASSWORD_LENGTH = 10;

export interface UserStore {
  insert(user: LocalUser): Promise<void>;
  findById(id: string): Promise<LocalUser | null>;
  findByUsername(username: string): Promise<LocalUser | null>;
  all(): Promise<LocalUser[]>;
  save(user: LocalUser): Promise<void>;
  count(): Promise<number>;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: AuthContext['role'];
  tenantId?: string | null;
}

export interface UpdateUserInput {
  role?: AuthContext['role'];
  tenantId?: string | null;
  isActive?: boolean;
  password?: string;
}

function roleRank(role: AuthContext['role']): number {
  return role === 'superadmin' ? 3 : role === 'admin' ? 2 : 1;
}

export function toUserPublic(user: LocalUser): Omit<LocalUser, 'passwordHash'> {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    tenantId: user.tenantId,
    isActive: user.isActive,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function assertManageAllowed(auth: AuthContext): void {
  if (auth.viaApiKey) {
    throw new ForbiddenError('API keys cannot manage users');
  }
  if (auth.role !== 'superadmin' && auth.role !== 'admin') {
    throw new ForbiddenError('Only admins may manage users');
  }
}

/**
 * Local user management (AUTH_MODE=local). Admins manage users of their own
 * tenant only and never above their own role; superadmins are unrestricted.
 * There is no self-signup: every account is created by an admin (or the
 * bootstrap admin on first boot) and verified via POST /auth/login.
 */
export class UserService {
  constructor(
    private readonly store: UserStore,
    private readonly audit?: AuditSink,
  ) {}

  async count(): Promise<number> {
    return this.store.count();
  }

  async findByUsername(username: string): Promise<LocalUser | null> {
    const normalized = normalizeUsername(username);
    if (!normalized) {
      return null;
    }
    return this.store.findByUsername(normalized);
  }

  /** Internal lookup by id (used by /auth/me) — no RBAC, caller scopes to self. */
  async findById(id: string): Promise<Omit<LocalUser, 'passwordHash'> | null> {
    const user = await this.store.findById(id);
    return user ? toUserPublic(user) : null;
  }

  async verifyCredentials(
    username: string,
    password: string,
  ): Promise<LocalUser | null> {
    const user = await this.findByUsername(username);
    if (!user || !user.isActive) {
      return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? user : null;
  }

  async createUser(
    auth: AuthContext,
    input: CreateUserInput,
  ): Promise<Omit<LocalUser, 'passwordHash'>> {
    assertManageAllowed(auth);
    const username = normalizeUsername(input.username);
    if (!username) {
      throw new ValidationError(
        'Username must be 3-64 chars: a-z, 0-9, dot, underscore, hyphen',
      );
    }
    if (!input.password || input.password.length < LOCAL_MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `Password must be at least ${LOCAL_MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (!['superadmin', 'admin', 'user'].includes(input.role)) {
      throw new ValidationError('Unknown role');
    }
    if (roleRank(input.role) > roleRank(auth.role)) {
      throw new ForbiddenError('User role must not exceed your own role');
    }
    const tenantId = sanitizeTenantId(input.tenantId ?? null);
    if (auth.role === 'admin') {
      if (!auth.tenantId || tenantId !== auth.tenantId) {
        throw new ForbiddenError('Admins may only create users for their own tenant');
      }
    }
    if (await this.store.findByUsername(username)) {
      throw new ValidationError(`User "${username}" already exists`);
    }

    const now = new Date().toISOString();
    const user: LocalUser = {
      id: crypto.randomUUID(),
      username,
      passwordHash: await hashPassword(input.password),
      role: input.role,
      tenantId,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.insert(user);
    await this.audit?.record({
      actorId: auth.userId,
      tenantId: user.tenantId,
      action: 'user.created',
      subjectId: `user:${user.username}`,
      detail: { role: user.role },
    });
    return toUserPublic(user);
  }

  async listUsers(auth: AuthContext): Promise<Omit<LocalUser, 'passwordHash'>[]> {
    assertManageAllowed(auth);
    const all = await this.store.all();
    const visible
      = auth.role === 'superadmin'
        ? all
        : all.filter((u) => u.tenantId !== null && u.tenantId === auth.tenantId);
    return visible.map(toUserPublic);
  }

  async updateUser(
    auth: AuthContext,
    id: string,
    input: UpdateUserInput,
  ): Promise<Omit<LocalUser, 'passwordHash'>> {
    assertManageAllowed(auth);
    const user = await this.store.findById(id);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    if (
      auth.role === 'admin'
      && (user.tenantId === null || user.tenantId !== auth.tenantId)
    ) {
      throw new ForbiddenError('Admins may only manage users of their own tenant');
    }
    if (input.role !== undefined) {
      if (!['superadmin', 'admin', 'user'].includes(input.role)) {
        throw new ValidationError('Unknown role');
      }
      if (roleRank(input.role) > roleRank(auth.role)) {
        throw new ForbiddenError('User role must not exceed your own role');
      }
      user.role = input.role;
    }
    if (input.tenantId !== undefined) {
      const tenantId = sanitizeTenantId(input.tenantId);
      if (auth.role === 'admin' && tenantId !== auth.tenantId) {
        throw new ForbiddenError('Admins may only manage users of their own tenant');
      }
      user.tenantId = tenantId;
    }
    if (input.isActive !== undefined) {
      if (user.id === auth.userId && input.isActive === false) {
        throw new ForbiddenError('You cannot deactivate your own account');
      }
      user.isActive = input.isActive;
    }
    if (input.password !== undefined) {
      if (input.password.length < LOCAL_MIN_PASSWORD_LENGTH) {
        throw new ValidationError(
          `Password must be at least ${LOCAL_MIN_PASSWORD_LENGTH} characters`,
        );
      }
      user.passwordHash = await hashPassword(input.password);
    }
    user.updatedAt = new Date().toISOString();
    await this.store.save(user);
    await this.audit?.record({
      actorId: auth.userId,
      tenantId: user.tenantId,
      action: input.isActive === false ? 'user.deactivated' : 'user.updated',
      subjectId: `user:${user.username}`,
      detail: { role: user.role, isActive: user.isActive },
    });
    return toUserPublic(user);
  }

  /** Deactivation (soft-delete): the record stays for audit traceability. */
  async deactivateUser(
    auth: AuthContext,
    id: string,
  ): Promise<Omit<LocalUser, 'passwordHash'>> {
    return this.updateUser(auth, id, { isActive: false });
  }
}
