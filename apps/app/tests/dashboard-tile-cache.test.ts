import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";

import {
  clearDashboardTileCacheStorage,
  DASHBOARD_TILE_CACHE_STORAGE_PREFIX,
  flushDashboardTileCacheStorage,
  resetDashboardTileCacheMemory,
} from "../src/app/lib/dashboard-cache-storage";
import {
  DASHBOARD_AUTO_REFRESH_INTERVAL_MS,
  dashboardTileCacheScopeKey,
  dashboardTileLaunchIsApproved,
  dashboardTileRunsAutomatically,
  readDashboardTileCache,
  removeDashboardTileCache,
  shouldAutoRefreshDashboardTile,
  writeDashboardTileCache,
  type DashboardTileCache,
} from "../src/react-app/domains/dashboard/dashboard-tile-cache";

const originalWindow = globalThis.window;

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function installWindow(localStorage = memoryStorage()): Storage {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { localStorage }),
  });
  return localStorage;
}

function storageEvent(storage: Storage, key: string | null): void {
  window.dispatchEvent(Object.assign(new Event("storage"), { storageArea: storage, key }));
}

const cache: DashboardTileCache = {
  cachedAt: 1_000_000,
  workspaceId: "workspace_reports",
  app: {
    serverName: "reports",
    toolName: "show_report",
    resourceUri: "ui://reports/dashboard.html",
    html: "<p>Saved report</p>",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    prefersBorder: true,
  },
  result: {
    content: [{ type: "text", text: "Saved report" }],
    structuredContent: { total: 42 },
  },
};

beforeEach(() => {
  setSystemTime(cache.cachedAt);
});

afterEach(() => {
  resetDashboardTileCacheMemory();
  mock.restore();
  setSystemTime();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("dashboard tile cache", () => {
  test("automatically runs only opted-in apps that do not require approval", () => {
    expect(dashboardTileRunsAutomatically(false, false, false, false)).toBe(false);
    expect(dashboardTileRunsAutomatically(false, true, false, false)).toBe(true);
    expect(dashboardTileRunsAutomatically(true, true, false, false)).toBe(false);
    expect(dashboardTileRunsAutomatically(false, true, true, false)).toBe(false);
    expect(dashboardTileRunsAutomatically(true, false, false, true)).toBe(true);
    expect(dashboardTileRunsAutomatically(true, false, true, true)).toBe(true);
  });

  test("treats organization auto-launch as approval for the exact managed call", () => {
    expect(dashboardTileLaunchIsApproved(false, false)).toBe(false);
    expect(dashboardTileLaunchIsApproved(false, true)).toBe(true);
    expect(dashboardTileLaunchIsApproved(true, false)).toBe(true);
  });

  test("keeps last-known-good app data isolated by user and organization with its originating workspace", () => {
    installWindow();
    const aliceOps = dashboardTileCacheScopeKey("user_alice", "org_ops");
    const aliceFinance = dashboardTileCacheScopeKey("user_alice", "org_finance");
    const bobOps = dashboardTileCacheScopeKey("user_bob", "org_ops");

    writeDashboardTileCache(aliceOps, "tile_report", cache);

    expect(readDashboardTileCache(aliceOps, "tile_report", cache.cachedAt)).toEqual(cache);
    expect(readDashboardTileCache(aliceOps, "tile_report", cache.cachedAt)?.workspaceId).toBe("workspace_reports");
    expect(readDashboardTileCache(aliceFinance, "tile_report", cache.cachedAt)).toBeNull();
    expect(readDashboardTileCache(bobOps, "tile_report", cache.cachedAt)).toBeNull();
  });

  test("rejects expired and malformed saved results", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_alice", "org_ops");
    writeDashboardTileCache(scope, "tile_report", cache);

    expect(readDashboardTileCache(scope, "tile_report", cache.cachedAt + 24 * 60 * 60 * 1_000 + 1)).toBeNull();

    storage.setItem(scope, JSON.stringify({ tile_report: { cachedAt: cache.cachedAt, app: {}, result: {} } }));
    resetDashboardTileCacheMemory();
    expect(readDashboardTileCache(scope, "tile_report", cache.cachedAt)).toBeNull();

    storage.setItem(scope, JSON.stringify({
      tile_report: { ...cache, workspaceId: "" },
    }));
    resetDashboardTileCacheMemory();
    expect(readDashboardTileCache(scope, "tile_report", cache.cachedAt)).toBeNull();
  });

  test("persists preview data without live launch or refresh authority", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("fixture-user", "fixture-org");
    const app = { ...cache.app };
    Object.assign(app, { launchId: "private-live-launch", refresh: { token: "private-refresh-authority" } });
    writeDashboardTileCache(scope, "tile", { ...cache, app });
    expect(readDashboardTileCache(scope, "tile", cache.cachedAt)).toEqual(cache);
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toContain("Saved report");
    expect(storage.getItem(scope)).not.toContain("launchId");
    expect(storage.getItem(scope)).not.toContain("refresh");
    resetDashboardTileCacheMemory();
    expect(readDashboardTileCache(scope, "tile", cache.cachedAt)).toEqual(cache);
  });

  test.each([true, false, undefined])("retains the result error flag across cache restoration (isError=%s)", (isError) => {
    installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const saved = { ...cache, result: { ...cache.result, ...(isError === undefined ? {} : { isError }), _meta: { privateFixture: "view-only" } } };
    writeDashboardTileCache(scope, "tile_report", saved);
    expect(readDashboardTileCache(scope, "tile_report", cache.cachedAt)).toEqual(saved);
  });

  test("hydrates a near-limit scope once across repeated reads of different tiles", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const large = { ...cache, result: { content: [{ type: "text", text: "x".repeat(2_900_000) }] } };
    storage.setItem(scope, JSON.stringify({ large, other: cache }));
    const reads = spyOn(storage, "getItem");
    const parses = spyOn(JSON, "parse");
    const saved = readDashboardTileCache(scope, "large");

    for (let index = 0; index < 30; index += 1) {
      expect(readDashboardTileCache(scope, "large")).toBe(saved);
      expect(readDashboardTileCache(scope, "other")?.workspaceId).toBe(cache.workspaceId);
      expect(readDashboardTileCache(scope, "missing")).toBeNull();
    }
    expect(saved?.result.content).toEqual(large.result.content);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(parses).toHaveBeenCalledTimes(1);
  });

  test("updates in memory immediately and coalesces persistence for a scope", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const reads = spyOn(storage, "getItem");
    const writes = spyOn(storage, "setItem");
    const latest = { ...cache, argumentsSignature: '{"project":"latest"}' };
    writeDashboardTileCache(scope, "tile", cache);
    writeDashboardTileCache(scope, "other", cache);
    writeDashboardTileCache(scope, "tile", latest);
    expect(readDashboardTileCache(scope, "tile")).toEqual(latest);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();

    flushDashboardTileCacheStorage();
    flushDashboardTileCacheStorage();
    expect(writes).toHaveBeenCalledTimes(1);
    const persisted: unknown = JSON.parse(storage.getItem(scope) ?? "null");
    expect(persisted).toEqual({ tile: latest, other: cache });
  });

  test("retains exact workspace and argument signatures while rejecting malformed identities", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const signature = '{"workspace":"exact"}';
    storage.setItem(scope, JSON.stringify({
      exact: { ...cache, argumentsSignature: signature },
      invalidSignature: { ...cache, argumentsSignature: { approved: true } },
      blankWorkspace: { ...cache, workspaceId: " " },
      missingWorkspace: { ...cache, workspaceId: undefined },
      invalidTime: { ...cache, cachedAt: 0 },
    }));
    expect(readDashboardTileCache(scope, "exact")).toEqual({ ...cache, argumentsSignature: signature });
    expect(readDashboardTileCache(scope, "invalidSignature")?.argumentsSignature).toBeUndefined();
    expect(readDashboardTileCache(scope, "blankWorkspace")).toBeNull();
    expect(readDashboardTileCache(scope, "missingWorkspace")).toBeNull();
    expect(readDashboardTileCache(scope, "invalidTime")).toBeNull();
  });

  test("strips legacy launch and refresh authority during hydration and later persistence", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    storage.setItem(scope, JSON.stringify({
      legacy: { ...cache, app: { ...cache.app, launchId: "old-lease", refresh: { token: "old-authority" } } },
    }));
    expect(readDashboardTileCache(scope, "legacy")).toEqual(cache);
    writeDashboardTileCache(scope, "new", cache);
    flushDashboardTileCacheStorage();
    const persisted: unknown = JSON.parse(storage.getItem(scope) ?? "null");
    expect(persisted).toEqual({ legacy: cache, new: cache });
  });

  test.each(["{", "null", "[]"])("recovers from corrupt scope data (%s)", (raw) => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    storage.setItem(scope, raw);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    writeDashboardTileCache(scope, "tile", cache);
    expect(() => flushDashboardTileCacheStorage()).not.toThrow();
    resetDashboardTileCacheMemory();
    expect(readDashboardTileCache(scope, "tile")).toEqual(cache);
  });

  test("blocked reads and quota failures leave live in-memory results usable", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const reads = spyOn(storage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    writeDashboardTileCache(scope, "tile", cache);
    expect(() => flushDashboardTileCacheStorage()).not.toThrow();
    expect(readDashboardTileCache(scope, "tile")).toEqual(cache);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  test("guards access to localStorage itself without retaining an old memory result", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "tile", cache);
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(() => writeDashboardTileCache(scope, "tile", cache)).not.toThrow();
    expect(() => flushDashboardTileCacheStorage()).not.toThrow();
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
  });

  test("expires a hydrated result at the same 24-hour boundary", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "tile", cache);
    flushDashboardTileCacheStorage();
    setSystemTime(cache.cachedAt + 24 * 60 * 60 * 1_000);
    expect(readDashboardTileCache(scope, "tile")).toEqual(cache);
    setSystemTime(Date.now() + 1);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBeNull();
  });

  test("evicts oldest results from memory and disk to keep the scope below 3M characters", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const result = { content: [{ type: "text", text: "x".repeat(1_050_000) }] };
    for (let index = 0; index < 3; index += 1) {
      writeDashboardTileCache(scope, `tile_${index}`, { ...cache, result, cachedAt: cache.cachedAt - 3 + index });
    }
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)?.length).toBeLessThanOrEqual(3_000_000);
    expect(readDashboardTileCache(scope, "tile_0")).toBeNull();
    expect(readDashboardTileCache(scope, "tile_1")?.result).toEqual(result);
    expect(readDashboardTileCache(scope, "tile_2")?.result).toEqual(result);
    resetDashboardTileCacheMemory();
    expect(readDashboardTileCache(scope, "tile_0")).toBeNull();
    expect(readDashboardTileCache(scope, "tile_2")?.result).toEqual(result);
  });

  test("an oversized or unserializable result cannot poison other saved tiles", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    writeDashboardTileCache(scope, "good", cache);
    writeDashboardTileCache(scope, "oversized", { ...cache, app: { ...cache.app, html: "x".repeat(3_000_000) } });
    writeDashboardTileCache(scope, "circular", { ...cache, result: { content: [], structuredContent: circular } });
    expect(() => flushDashboardTileCacheStorage()).not.toThrow();
    const persisted: unknown = JSON.parse(storage.getItem(scope) ?? "null");
    expect(persisted).toEqual({ good: cache });
    expect(readDashboardTileCache(scope, "oversized")).toBeNull();
    expect(readDashboardTileCache(scope, "circular")).toBeNull();
  });

  test("removal updates the memory index and supersedes pending writes", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "removed", cache);
    writeDashboardTileCache(scope, "kept", cache);
    flushDashboardTileCacheStorage();
    writeDashboardTileCache(scope, "removed", { ...cache, argumentsSignature: "pending" });
    removeDashboardTileCache(scope, "removed");
    expect(readDashboardTileCache(scope, "removed")).toBeNull();
    flushDashboardTileCacheStorage();
    resetDashboardTileCacheMemory();
    expect(readDashboardTileCache(scope, "removed")).toBeNull();
    expect(readDashboardTileCache(scope, "kept")).toEqual(cache);
    removeDashboardTileCache(scope, "kept");
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBeNull();
  });

  test("storage events invalidate only the changed scope and cancel stale pending writes", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const otherScope = dashboardTileCacheScopeKey("user_fixture", "other_org");
    storage.setItem(scope, JSON.stringify({ tile: cache }));
    storage.setItem(otherScope, JSON.stringify({ tile: cache }));
    expect(readDashboardTileCache(scope, "tile")).toEqual(cache);
    const other = readDashboardTileCache(otherScope, "tile");
    writeDashboardTileCache(scope, "tile", { ...cache, argumentsSignature: "pending" });
    const external = { ...cache, argumentsSignature: "external" };
    storage.setItem(scope, JSON.stringify({ tile: external }));
    storageEvent(storage, scope);
    expect(readDashboardTileCache(scope, "tile")).toEqual(external);
    expect(readDashboardTileCache(otherScope, "tile")).toBe(other);
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBe(JSON.stringify({ tile: external }));

    storage.removeItem(scope);
    storageEvent(storage, scope);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(readDashboardTileCache(otherScope, "tile")).toBe(other);
  });

  test("a whole-storage clear event cancels all pending scopes, but other storage areas do not", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "tile", cache);
    storageEvent(memoryStorage(), null);
    expect(readDashboardTileCache(scope, "tile")).toEqual(cache);
    storage.clear();
    storageEvent(storage, null);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBeNull();
  });

  test("logout signals other windows even when the only results are pending in memory", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "tile", cache);
    const writes = spyOn(storage, "setItem");
    clearDashboardTileCacheStorage(storage);
    expect(writes).toHaveBeenCalledWith(`${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.clear`, "1");
    expect(storage.length).toBe(0);
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBeNull();
  });

  test("a clear signal discards pending-only scopes and suppresses leftover disk data", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const otherScope = dashboardTileCacheScopeKey("other_user", "org_fixture");
    storage.setItem(scope, JSON.stringify({ tile: cache }));
    expect(readDashboardTileCache(scope, "tile")).toEqual(cache);
    writeDashboardTileCache(otherScope, "tile", cache);
    storageEvent(storage, `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.clear`);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(readDashboardTileCache(otherScope, "tile")).toBeNull();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(otherScope)).toBeNull();
  });

  test("switching storage cannot reuse or flush the previous account's memory index", () => {
    const previousStorage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "tile", cache);
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    flushDashboardTileCacheStorage();
    expect(previousStorage.getItem(scope)).toBeNull();
  });

  test("logout clears every dashboard scope and cancels even an already-queued persistence callback", () => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    const otherScope = dashboardTileCacheScopeKey("other_user", "org_fixture");
    storage.setItem("unrelated", "kept");
    storage.setItem(`${scope}.geometry`, "old geometry");
    writeDashboardTileCache(scope, "tile", cache);
    writeDashboardTileCache(otherScope, "tile", cache);
    flushDashboardTileCacheStorage();
    const scheduled = spyOn(globalThis, "setTimeout");
    const cancelled = spyOn(globalThis, "clearTimeout");
    writeDashboardTileCache(scope, "tile", { ...cache, argumentsSignature: "pending" });
    const pending = scheduled.mock.calls[0]?.[0];
    const handle = scheduled.mock.results[0]?.value;
    clearDashboardTileCacheStorage(storage);
    expect(cancelled).toHaveBeenCalledWith(handle);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(readDashboardTileCache(otherScope, "tile")).toBeNull();
    expect(typeof pending).toBe("function");
    if (typeof pending === "function") pending();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBeNull();
    expect(storage.getItem(otherScope)).toBeNull();
    expect(storage.getItem(`${scope}.geometry`)).toBeNull();
    expect(storage.getItem("unrelated")).toBe("kept");
  });

  test.each(["enumeration", "removal"])("logout stays cleared in memory when storage %s fails", (failure) => {
    const storage = installWindow();
    const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
    writeDashboardTileCache(scope, "tile", cache);
    flushDashboardTileCacheStorage();
    writeDashboardTileCache(scope, "tile", { ...cache, argumentsSignature: "pending" });
    if (failure === "enumeration") {
      Object.defineProperty(storage, "length", { get() { throw new Error("blocked"); } });
    } else {
      spyOn(storage, "removeItem").mockImplementation(() => { throw new Error("blocked"); });
    }
    expect(() => clearDashboardTileCacheStorage(storage)).not.toThrow();
    expect(storage.getItem(scope)).not.toBeNull();
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(() => flushDashboardTileCacheStorage()).not.toThrow();
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
  });

  test("refreshes only visible, stale, non-refreshing tiles", () => {
    const dueAt = cache.cachedAt + DASHBOARD_AUTO_REFRESH_INTERVAL_MS;
    expect(shouldAutoRefreshDashboardTile({
      visible: true,
      refreshing: false,
      lastRefreshAt: cache.cachedAt,
      now: dueAt,
    })).toBe(true);
    expect(shouldAutoRefreshDashboardTile({
      visible: false,
      refreshing: false,
      lastRefreshAt: cache.cachedAt,
      now: dueAt,
    })).toBe(false);
    expect(shouldAutoRefreshDashboardTile({
      visible: true,
      refreshing: true,
      lastRefreshAt: cache.cachedAt,
      now: dueAt,
    })).toBe(false);
    expect(shouldAutoRefreshDashboardTile({
      visible: true,
      refreshing: false,
      lastRefreshAt: cache.cachedAt,
      now: dueAt - 1,
    })).toBe(false);
  });
});
