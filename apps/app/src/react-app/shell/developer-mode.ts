import { useSyncExternalStore } from "react";

export const DEVELOPER_MODE_STORAGE_KEY = "openwork.developerMode";

type DeveloperModeStorage = Pick<Storage, "getItem" | "setItem">;

export type DeveloperModeStore = {
  getSnapshot: () => boolean;
  getServerSnapshot: () => false;
  set: (enabled: boolean) => void;
  toggle: () => void;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Creates the small external store used by every developer-mode control.
 * Keeping the storage adapter injectable makes same-window reactivity testable
 * without a DOM while the singleton below still follows cross-window storage
 * events in the desktop/web runtime.
 */
export function createDeveloperModeStore(
  storage: DeveloperModeStorage | null,
  subscribeToStorage?: (listener: () => void) => () => void,
): DeveloperModeStore {
  const listeners = new Set<() => void>();
  let disposeStorageListener: (() => void) | null = null;

  const readStorage = () => {
    if (!storage) return false;
    try {
      return storage.getItem(DEVELOPER_MODE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  };
  let current = readStorage();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const refresh = () => {
    const next = readStorage();
    if (next === current) return;
    current = next;
    emit();
  };

  return {
    getSnapshot: () => current,
    getServerSnapshot: () => false,
    set(enabled) {
      try {
        storage?.setItem(DEVELOPER_MODE_STORAGE_KEY, enabled ? "1" : "0");
      } catch {
        // Keep the current window reactive even when persistence is blocked.
      }
      if (current === enabled) return;
      current = enabled;
      emit();
    },
    toggle() {
      this.set(!current);
    },
    subscribe(listener) {
      listeners.add(listener);
      refresh();
      if (listeners.size === 1 && subscribeToStorage) {
        disposeStorageListener = subscribeToStorage(refresh);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          disposeStorageListener?.();
          disposeStorageListener = null;
        }
      };
    },
  };
}

function browserStorage(): DeveloperModeStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const developerModeStore = createDeveloperModeStore(browserStorage(), (emit) => {
  if (typeof window === "undefined") return () => {};
  const onStorage = (event: StorageEvent) => {
    if (event.key === DEVELOPER_MODE_STORAGE_KEY || event.key === null) emit();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
});

export function getDeveloperMode() {
  return developerModeStore.getSnapshot();
}

export function setDeveloperMode(enabled: boolean) {
  developerModeStore.set(enabled);
}

export function toggleDeveloperMode() {
  developerModeStore.toggle();
}

export function useDeveloperMode() {
  return useSyncExternalStore(
    developerModeStore.subscribe,
    developerModeStore.getSnapshot,
    developerModeStore.getServerSnapshot,
  );
}
