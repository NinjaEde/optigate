import { describe, it, expect } from 'vitest';

import {
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

describe('resolveStatusForNewServer', () => {
  it('returns healthy when approval is not required', () => {
    expect(resolveStatusForNewServer(false)).toBe('healthy');
  });

  it('returns pending_approval when approval policy demands it', () => {
    expect(resolveStatusForNewServer(true)).toBe('pending_approval');
  });
});
