/** Bounded per-isolate cache. A failed loader never replaces a good entry. */
export class BoundedCache<T> {
  readonly #entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    readonly maxEntries: number,
    readonly ttlMs: number,
    readonly now: () => number = Date.now,
  ) {}
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: T): T {
    if (!this.#entries.has(key) && this.#entries.size >= this.maxEntries) {
      const first = this.#entries.keys().next().value;
      if (first !== undefined) this.#entries.delete(first);
    }
    this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }
  invalidate(key?: string): void {
    if (key === undefined) this.#entries.clear();
    else this.#entries.delete(key);
  }
}
