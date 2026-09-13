import type { SettingsStore } from '../../services/settingsService.js';

/** In-memory settings overrides — used for tests and as dev fallback. */
export class InMemorySettingsStore implements SettingsStore {
  private readonly store = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async set(key: string, value: unknown, _updatedBy: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async all(): Promise<Record<string, unknown>> {
    return Object.fromEntries(this.store.entries());
  }
}
