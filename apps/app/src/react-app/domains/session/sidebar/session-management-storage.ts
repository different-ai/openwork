import type { StateStorage } from "zustand/middleware";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decode(raw: string | null): { state: Record<string, unknown>; version?: number } | null {
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!record(value) || !record(value.state) || !Array.isArray(value.state.pinnedIds)
    || !value.state.pinnedIds.every((id: unknown) => typeof id === "string" && id.length > 0)) {
    throw new Error("Invalid persisted session management state");
  }
  return { state: value.state, ...(typeof value.version === "number" ? { version: value.version } : {}) };
}

/** Never persist a default over state that could not be hydrated. Desktop pin
 * mutations are fsynced before returning, independently of Chromium's cache. */
export function sessionManagementStorage(): StateStorage {
  const journal = typeof window === "undefined" ? undefined : window.__OPENWORK_ELECTRON__?.sessionPins;
  let hydrated = false;
  let localReadable = false;
  let previous: string[] = [];
  return {
    getItem(key) {
      hydrated = false;
      localReadable = false;
      let legacy: ReturnType<typeof decode> = null;
      let localFailure: unknown;
      try {
        legacy = decode(localStorage.getItem(key));
        localReadable = true;
      } catch (error) { localFailure = error; }
      const saved = journal?.read();
      if (saved && !saved.ok) throw new Error(saved.error);
      let pins = saved?.pins;
      if (pins === null || pins === undefined) {
        if (!localReadable) throw localFailure;
        const legacyPins = legacy?.state.pinnedIds;
        pins = Array.isArray(legacyPins) ? legacyPins.filter((id): id is string => typeof id === "string") : [];
        if (journal) {
          const migrated = journal.update({ previous: [], next: pins });
          if (!migrated.ok) throw new Error(migrated.error);
          pins = migrated.pins;
        }
      }
      previous = pins;
      hydrated = true;
      // The journal can recover pins even when Chromium cannot read its key.
      // Do not subsequently replace that failed key with unrelated defaults.
      return JSON.stringify({ ...legacy, state: { ...legacy?.state, pinnedIds: pins } });
    },
    setItem(key, raw) {
      if (!hydrated) return;
      const value = decode(raw);
      if (!value) return;
      const next = value.state.pinnedIds;
      if (!Array.isArray(next)) throw new Error("Invalid session pins");
      const intended = next.filter((id): id is string => typeof id === "string");
      if (journal && JSON.stringify(previous) !== JSON.stringify(intended)) {
        const saved = journal.update({ previous, next: intended });
        if (!saved.ok) throw new Error(saved.error);
      }
      previous = intended;
      if (localReadable) localStorage.setItem(key, raw);
    },
    removeItem(key) {
      // Clearing a UI cache is not an instruction to discard durable pins.
      if (hydrated && localReadable) localStorage.removeItem(key);
    },
  };
}
