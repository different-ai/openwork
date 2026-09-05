import { afterEach, describe, expect, test } from "bun:test";

import {
  DASHBOARD_AUTO_REFRESH_INTERVAL_MS,
  dashboardTileCacheScopeKey,
  dashboardTileLaunchIsApproved,
  dashboardTileRunsAutomatically,
  readDashboardTileCache,
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

function installWindow(): Storage {
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage },
  });
  return localStorage;
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

afterEach(() => {
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
    expect(readDashboardTileCache(scope, "tile_report", cache.cachedAt)).toBeNull();

    storage.setItem(scope, JSON.stringify({
      tile_report: { ...cache, workspaceId: "" },
    }));
    expect(readDashboardTileCache(scope, "tile_report", cache.cachedAt)).toBeNull();
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
