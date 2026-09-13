import { describe, it, expect } from 'vitest';

import {
  canManage,
  canView,
  canRegister,
  canApprove,
  resolveStatusForNewServer,
} from '../../src/domain/policy';
import type { MCPServer, AuthContext } from '../../src/domain/types';

const auth = (role: AuthContext['role'], tenantId: string): AuthContext => ({
  userId: 'u1',
  role,
  tenantId,
});

const server = (over: Partial<MCPServer> = {}): MCPServer => ({
  id: 'srv-1',
  tenantId: 't1',
  name: 'rag-search',
  description: '',
  scope: 'tenant',
  shared: false,
  ownerId: null,
  transport: 'streamable_http',
  connection: {},
  status: 'healthy',
  createdBy: 'u1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  ...over,
});

describe('canView', () => {
  it('allows global servers for any authenticated user', () => {
    expect(canView(server({ scope: 'global', tenantId: null }), auth('user', 't2'))).toBe(true);
  });

  it('allows same-tenant servers', () => {
    expect(canView(server({ scope: 'tenant', tenantId: 't1' }), auth('user', 't1'))).toBe(true);
  });

  it('denies other tenants servers', () => {
    expect(canView(server({ scope: 'tenant', tenantId: 't1' }), auth('user', 't2'))).toBe(false);
  });

  it('allows private servers only for their owner or superadmin', () => {
    const priv = server({ scope: 'private', tenantId: 't1', ownerId: 'u9' });
    expect(canView(priv, auth('user', 't1'))).toBe(false);
    expect(canView(priv, auth('user', 't1'))).toBe(false);
    expect(canView({ ...priv, ownerId: 'u1' }, auth('user', 't1'))).toBe(true);
    expect(canView(priv, auth('superadmin', 't2'))).toBe(true);
  });
});

describe('canRegister / canApprove', () => {
  it('admins may register for their tenant', () => {
    expect(canRegister(auth('admin', 't1'), 'tenant')).toBe(true);
  });

  it('plain users may not register global servers', () => {
    expect(canRegister(auth('user', 't1'), 'global')).toBe(false);
  });

  it('only superadmin may approve', () => {
    expect(canApprove(auth('superadmin', 't1'))).toBe(true);
    expect(canApprove(auth('admin', 't1'))).toBe(false);
  });
});

describe('canManage', () => {
  it('superadmin manages everything', () => {
    expect(canManage(auth('superadmin', 't9'), server())).toBe(true);
    expect(
      canManage(auth('superadmin', 't9'), server({ scope: 'global', tenantId: null })),
    ).toBe(true);
  });

  it('admin manages own-tenant servers only', () => {
    expect(canManage(auth('admin', 't1'), server())).toBe(true);
    expect(canManage(auth('admin', 't2'), server())).toBe(false);
  });

  it('plain users manage nothing except owned private servers', () => {
    expect(canManage(auth('user', 't1'), server())).toBe(false);
    const owned = server({ scope: 'private', ownerId: 'u1' });
    // auth() helper pins userId to 'u1', i.e. the owner here
    expect(canManage(auth('user', 't1'), owned)).toBe(true);
    const stranger: AuthContext = { userId: 'u2', role: 'user', tenantId: 't1' };
    expect(canManage(stranger, owned)).toBe(false);
  });

  it('global and shared servers are superadmin-only', () => {
    expect(
      canManage(auth('admin', 't1'), server({ scope: 'global', tenantId: null })),
    ).toBe(false);
    expect(canManage(auth('admin', 't1'), server({ shared: true }))).toBe(false);
  });
});

describe('resolveStatusForNewServer', () => {
  it('returns healthy when approval is not required', () => {
    expect(resolveStatusForNewServer(false)).toBe('healthy');
  });

  it('returns pending_approval when approval policy demands it', () => {
    expect(resolveStatusForNewServer(true)).toBe('pending_approval');
  });
});
