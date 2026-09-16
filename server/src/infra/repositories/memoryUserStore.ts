import type { LocalUser } from '../../domain/types.js';
import type { UserStore } from '../../services/userService.js';

/** In-memory local user store — tests, dev fallback, local mode w/o DB. */
export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, LocalUser>();
  private readonly idByUsername = new Map<string, string>();

  async insert(user: LocalUser): Promise<void> {
    this.byId.set(user.id, { ...user });
    this.idByUsername.set(user.username, user.id);
  }

  async findById(id: string): Promise<LocalUser | null> {
    const u = this.byId.get(id);
    return u ? { ...u } : null;
  }

  async findByUsername(username: string): Promise<LocalUser | null> {
    const id = this.idByUsername.get(username);
    if (!id) {
      return null;
    }
    return this.findById(id);
  }

  async all(): Promise<LocalUser[]> {
    return [...this.byId.values()]
      .map((u) => ({ ...u }))
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async save(user: LocalUser): Promise<void> {
    const prev = this.byId.get(user.id);
    if (prev && prev.username !== user.username) {
      this.idByUsername.delete(prev.username);
    }
    this.byId.set(user.id, { ...user });
    this.idByUsername.set(user.username, user.id);
  }

  async count(): Promise<number> {
    return this.byId.size;
  }
}
