import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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
    deleteServer: vi.fn(),
    disableServer: vi.fn(),
    approveServer: vi.fn(),
    refreshTools: vi.fn(),
  },
}));

describe('App', () => {
  it('renders registered servers from the API', async () => {
    render(<App />);

    const name = await screen.findByText('rag-search');
    expect(name).toBeInTheDocument();
  });

  it('shows the server count in the header', async () => {
    render(<App />);

    const subtitle = await screen.findByText(/1 Server/);
    expect(subtitle).toBeInTheDocument();
  });
});
