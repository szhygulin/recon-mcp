/** Minimal in-memory TTL cache. Not thread-safe — fine for a single-process MCP server. */

interface Entry {
  value: unknown;
  expiresAt: number;
}

class TTLCache {
  private store = new Map<string, Entry>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove every key starting with the given prefix. Useful for invalidating "aave:ethereum:*". */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  /**
   * Compute `fn()` if the key is missing or stale, otherwise return the cached value.
   * Concurrent calls for the same key will each compute the value — fine for MVP.
   */
  async remember<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }
}

export const cache = new TTLCache();
