export type Cleanup = () => void | PromiseLike<void>;

export interface Provider<T> {
  readonly load: (ctx: Ctx) => Promise<T>;
  readonly values: WeakMap<Ctx, Promise<T>>;
}

export function provider<T>(load: (ctx: Ctx) => Promise<T>): Provider<T> {
  return { load, values: new WeakMap() };
}

/** A run-scoped, lazy provider cache with last-created-first-disposed cleanup. */
export class Ctx {
  private readonly cleanups: Cleanup[] = [];

  use<T>(source: Provider<T>): Promise<T> {
    const existing = source.values.get(this);
    if (existing) return existing;
    const value = source.load(this);
    source.values.set(this, value);
    return value;
  }

  onDispose(cleanup: Cleanup): void {
    this.cleanups.push(cleanup);
  }

  async dispose(): Promise<void> {
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error("cleanup failed:", error);
      }
    }
    this.cleanups.length = 0;
  }
}
