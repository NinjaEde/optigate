import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';

import { App } from '../src/App';
import * as api from '../src/api';

vi.mock('../src/api', () => ({
  api: {
    listServers: vi.fn().mockResolvedValue([
      {
        id: 'srv-1',
        tenantId: 't1',
        name: 'rag-search',
        description: 'RAG tools',
        scope: 'tenant',
        ownerId: null,
        transport: 'streamable_http',
        connection: { url: 'https://mcp.example.com' },
        status: 'healthy',
        createdBy: 'u1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
      },
    ]),
    audit: vi.fn().mockResolvedValue([]),
    whoami: vi.fn().mockResolvedValue({ userId: 'u0', role: 'superadmin', tenantId: null }),
    deleteServer: vi.fn(),
    disableServer: vi.fn(),
    approveServer: vi.fn(),
    refreshTools: vi.fn(),
  },
}));

describe('App', () => {
  // no globals in vitest config → RTL auto-cleanup is off; unmount
  // explicitly so renders don't leak across tests
  afterEach(() => {
    cleanup();
  });

  it('renders registered servers from the API', async () => {
    render(<App />);

    const name = await screen.findByText('rag-search');
    expect(name).toBeInTheDocument();
  });

  it('shows the server count in the header', async () => {
    render(<App />);

    // count ("1") and label ("Server") live in separate dt/dd elements
    const stats = await screen.findByTestId('server-stats');
    const label = within(stats).getByText('Server');
    expect(label).toBeInTheDocument();
    // the count sits in the dd of the same row
    const row = label.closest('div');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});
