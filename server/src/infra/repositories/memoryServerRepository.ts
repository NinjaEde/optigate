import type { MCPServer } from '../../domain/types.js';
import type { ServerRepository } from '../../services/registryService.js';

/** In-memory repository — used for tests and as dev fallback. */
export class InMemoryServerRepository implements ServerRepository {
  private readonly store = new Map<string, MCPServer>();

  async insert(server: MCPServer): Promise<void> {
    this.store.set(server.id, { ...server });
  }

  async findById(id: string): Promise<MCPServer | null> {
    const s = this.store.get(id);
    return s ? { ...s } : null;
  }

  async findByNameInTenant(
    name: string,
    tenantId: string | null,
  ): Promise<MCPServer | null> {
    for (const s of this.store.values()) {
      if (s.name === name && (s.tenantId ?? null) === tenantId) {
        return { ...s };
      }
    }
    return null;
  }

  async allActive(): Promise<MCPServer[]> {
    return [...this.store.values()]
      .filter((s) => !s.deletedAt)
      .map((s) => ({ ...s }));
  }

  async save(server: MCPServer): Promise<void> {
    this.store.set(server.id, { ...server });
  }
}
