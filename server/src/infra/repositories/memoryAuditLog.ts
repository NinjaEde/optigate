import type { AuditEvent } from '../../domain/types.js';
import type { AuditSink } from '../../services/registryService.js';

export class InMemoryAuditLog implements AuditSink {
  readonly events: AuditEvent[] = [];

  async record(event: Omit<AuditEvent, 'id' | 'at'>): Promise<void> {
    this.events.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      ...event,
    });
  }

  async recent(limit = 100, tenantId?: string | null): Promise<AuditEvent[]> {
    let filtered = this.events;
    if (tenantId !== undefined) {
      filtered = filtered.filter(
        (e) => e.tenantId === tenantId || e.tenantId === null,
      );
    }
    return filtered.slice(0, limit);
  }
}
