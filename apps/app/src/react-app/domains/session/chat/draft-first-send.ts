/** A failed handoff retains its created session; concurrent submits share the work. */
export function createDraftFirstSend<T>() {
  const entries = new Map<string, { created?: T; pending?: Promise<void> }>();
  return {
    hasCreated(key: string) { return entries.get(key)?.created !== undefined; },
    move(source: string, destination: string) {
      const entry = entries.get(source);
      if (!entry) return;
      if (entry.pending || entries.has(destination)) throw new Error("Session is being prepared. Try again.");
      entries.set(destination, entry);
      entries.delete(source);
    },
    run(key: string, create: () => Promise<T>, handoff: (created: T) => Promise<void>): Promise<void> {
      const entry = entries.get(key) ?? {};
      if (entry.pending) return entry.pending;
      entries.set(key, entry);
      const pending = Promise.resolve().then(async () => {
        const created = entry.created ?? await create();
        entry.created = created;
        await handoff(created);
        entries.delete(key);
      }).finally(() => { entry.pending = undefined; });
      entry.pending = pending;
      return pending;
    },
  };
}
