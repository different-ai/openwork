export const DASHBOARD_TILE_CACHE_STORAGE_PREFIX = "openwork.react.dashboardTileCache.v1";

const PERSIST_DELAY_MS = 150;
const CLEAR_STORAGE_KEY = `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.clear`;
const stores = new Set<{
  invalidate: (key?: string | null) => void;
  flush: () => void;
}>();
const clearedStorages = new WeakSet<Storage>();
let observedWindow: Window | null = null;
let activeStorage: Storage | null = null;

function storageChanged(event: StorageEvent): void {
  if (event.storageArea && event.storageArea !== activeStorage) return;
  if (event.key === null || event.key === CLEAR_STORAGE_KEY) {
    if (activeStorage) clearedStorages.add(activeStorage);
    for (const store of stores) store.invalidate();
    return;
  }
  if (!event.key.startsWith(`${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.`)) return;
  for (const store of stores) store.invalidate(event.key);
}

export function resetDashboardTileCacheMemory(): void {
  for (const store of stores) store.invalidate();
  observedWindow?.removeEventListener?.("storage", storageChanged);
  observedWindow = null;
  activeStorage = null;
}

function currentStorage(): Storage | null {
  try {
    if (typeof window === "undefined") {
      resetDashboardTileCacheMemory();
      return null;
    }
    const storage = window.localStorage;
    if (observedWindow !== window || activeStorage !== storage) {
      resetDashboardTileCacheMemory();
      observedWindow = window;
      activeStorage = storage;
      window.addEventListener?.("storage", storageChanged);
    }
    return storage;
  } catch {
    resetDashboardTileCacheMemory();
    return null;
  }
}

export function createDashboardTileCacheStore<T>(
  parse: (value: unknown, now: number) => T,
  serialize: (value: T, now: number) => string | null,
) {
  type Scope = { storage: Storage; value: T; timer: ReturnType<typeof setTimeout> | null };
  const scopes = new Map<string, Scope>();

  function invalidate(key?: string | null): void {
    for (const [scopeKey, scope] of scopes) {
      if (key != null && scopeKey !== key) continue;
      if (scope.timer !== null) clearTimeout(scope.timer);
      scope.timer = null;
      scopes.delete(scopeKey);
    }
  }

  function persist(key: string, scope: Scope): void {
    if (scope.timer === null) return;
    clearTimeout(scope.timer);
    scope.timer = null;
    if (currentStorage() !== scope.storage || scopes.get(key) !== scope) return;
    try {
      const raw = serialize(scope.value, Date.now());
      if (raw === null) scope.storage.removeItem(key);
      else scope.storage.setItem(key, raw);
    } catch {}
  }

  stores.add({
    invalidate,
    flush() {
      for (const [key, scope] of scopes) persist(key, scope);
    },
  });

  return {
    read(key: string, now = Date.now()): T | null {
      const storage = currentStorage();
      if (!storage) return null;
      const cached = scopes.get(key);
      if (cached) return cached.value;
      let parsed: unknown = null;
      try {
        const raw = clearedStorages.has(storage) ? null : storage.getItem(key);
        if (raw !== null) parsed = JSON.parse(raw);
      } catch {}
      const value = parse(parsed, now);
      scopes.set(key, { storage, value, timer: null });
      return value;
    },
    schedule(key: string): void {
      const scope = scopes.get(key);
      if (!scope) return;
      if (scope.timer !== null) clearTimeout(scope.timer);
      scope.timer = setTimeout(() => persist(key, scope), PERSIST_DELAY_MS);
    },
  };
}

export function flushDashboardTileCacheStorage(): void {
  if (!currentStorage()) return;
  for (const store of stores) store.flush();
}

export function clearDashboardTileCacheStorage(storage: Storage): void {
  resetDashboardTileCacheMemory();
  const keys: string[] = [];
  let failed = false;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(`${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.`)) keys.push(key);
    }
  } catch {
    failed = true;
  }
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      failed = true;
    }
  }
  if (failed) clearedStorages.add(storage);
  else clearedStorages.delete(storage);
  try {
    storage.setItem(CLEAR_STORAGE_KEY, "1");
    storage.removeItem(CLEAR_STORAGE_KEY);
  } catch {}
}
