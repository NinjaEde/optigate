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
}
