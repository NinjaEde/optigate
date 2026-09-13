import type { ApiKey } from '../../domain/types.js';
import type { ApiKeyStore } from '../../services/apiKeyService.js';

/** In-memory API key store — used for tests and as dev fallback. */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private readonly store = new Map<string, ApiKey>();

  async insert(key: ApiKey): Promise<void> {
    this.store.set(key.id, { ...key });
  }

  async findByPrefix(prefix: string): Promise<ApiKey[]> {
    return [...this.store.values()]
      .filter((k) => k.keyPrefix === prefix)
      .map((k) => ({ ...k }));
  }

  async findById(id: string): Promise<ApiKey | null> {
    const k = this.store.get(id);
    return k ? { ...k } : null;
  }

  async all(): Promise<ApiKey[]> {
    return [...this.store.values()].map((k) => ({ ...k }));
  }

  async save(key: ApiKey): Promise<void> {
    this.store.set(key.id, { ...key });
  }
}
