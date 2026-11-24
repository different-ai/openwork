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
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key: string, value: T, bytes: number) {
    this.remove(key)
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
