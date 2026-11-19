/**
 * A small in-memory cache bounded by bytes and age, least recently used out first. Holds decoded segments and large
 * bodies briefly, so paging back through history or building several steps' context doesn't refetch them.
 */
export class ByteCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number; at: number }>()
  private total = 0

  constructor(
    private readonly maxBytes: number,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (this.now() - entry.at > this.maxAgeMs) {
      this.remove(key)
      return undefined
    }
    // Most recently used last.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, bytes: number) {
    this.remove(key)
    // Something bigger than the whole cache is used once and not kept.
    if (bytes > this.maxBytes) return
    this.entries.set(key, { value, bytes, at: this.now() })
    this.total += bytes
    for (const [oldest] of this.entries) {
      if (this.total <= this.maxBytes) break
      this.remove(oldest)
    }
  }

  remove(key: string) {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.total -= entry.bytes
  }

  clear() {
    this.entries.clear()
    this.total = 0
  }
}
