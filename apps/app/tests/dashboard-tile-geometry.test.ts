import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";

import {
  clearDashboardTileCacheStorage,
  flushDashboardTileCacheStorage,
  resetDashboardTileCacheMemory,
} from "../src/app/lib/dashboard-cache-storage";
import {
  dashboardTileCacheScopeKey,
  readDashboardTileCache,
  writeDashboardTileCache,
  type DashboardTileCache,
} from "../src/react-app/domains/dashboard/dashboard-tile-cache";
import {
  readDashboardTileGeometry,
  removeDashboardTileGeometry,
  writeDashboardTileGeometry,
  type DashboardTileGeometry,
} from "../src/react-app/domains/dashboard/dashboard-tile-geometry";

const originalWindow = globalThis.window;
const scope = dashboardTileCacheScopeKey("user_fixture", "org_fixture");
const storageKey = `${scope}.geometry`;
const geometry: DashboardTileGeometry = {
  workspaceId: "workspace_reports",
  contentWidth: 640,
  frameHeight: 600,
  outerHeight: 660,
  measuredAt: 1_800_000_000_000,
};
const resultCache: DashboardTileCache = {
  cachedAt: geometry.measuredAt,
  workspaceId: geometry.workspaceId,
  app: {
    serverName: "reports",
    toolName: "show_report",
    resourceUri: "ui://reports/dashboard.html",
    html: "<p>Saved report</p>",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
    prefersBorder: true,
  },
  result: { content: [{ type: "text", text: "Saved report" }] },
};

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear() { map.clear(); },
    getItem(key: string) { return map.get(key) ?? null; },
    key(index: number) { return Array.from(map.keys())[index] ?? null; },
    removeItem(key: string) { map.delete(key); },
    setItem(key: string, value: string) { map.set(key, value); },
  };
}

function installWindow(): Storage {
  const localStorage = memoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(new EventTarget(), { localStorage }),
  });
  return localStorage;
}

function storageEvent(storage: Storage, key: string | null): void {
  window.dispatchEvent(Object.assign(new Event("storage"), { storageArea: storage, key }));
}

beforeEach(() => {
  setSystemTime(geometry.measuredAt);
});

afterEach(() => {
  resetDashboardTileCacheMemory();
  mock.restore();
  setSystemTime();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("dashboard tile geometry", () => {
  test("isolates scope, tile, exact workspace and rounded content width", () => {
    installWindow();
    const desktop = { ...geometry, contentWidth: 800.2, measuredAt: geometry.measuredAt - 2 };
    const mobile = { ...geometry, contentWidth: 360.4, frameHeight: 400, outerHeight: 460, measuredAt: geometry.measuredAt - 1 };
    const otherWorkspace = { ...geometry, workspaceId: "workspace_other", contentWidth: 800 };
    writeDashboardTileGeometry(scope, "tile", desktop);
    writeDashboardTileGeometry(scope, "tile", mobile);
    writeDashboardTileGeometry(scope, "tile", otherWorkspace);

    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 800.49)).toEqual({ ...desktop, contentWidth: 800 });
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 360.1)).toEqual({ ...mobile, contentWidth: 360 });
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 800.6)).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 320)).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual({ ...mobile, contentWidth: 360 });
    expect(readDashboardTileGeometry(scope, "tile", "workspace_other")).toEqual(otherWorkspace);
    expect(readDashboardTileGeometry(scope, "tile", `${geometry.workspaceId} `)).toBeNull();
    expect(readDashboardTileGeometry(scope, "other_tile", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileGeometry(dashboardTileCacheScopeKey("other_user", "org_fixture"), "tile", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileGeometry(dashboardTileCacheScopeKey("user_fixture", "other_org"), "tile", geometry.workspaceId)).toBeNull();
  });

  test("persists only versioned geometry metadata, not authority or app data", () => {
    const storage = installWindow();
    const extra = { ...geometry };
    Object.assign(extra, {
      launchId: "fixture-lease", refresh: { token: "fixture-authority" }, url: "fixture-url",
      result: { private: "fixture-result" }, screenshot: "fixture-image", token: "fixture-token",
    });
    writeDashboardTileGeometry(scope, "tile", extra);
    const saved = readDashboardTileGeometry(scope, "tile", geometry.workspaceId);
    expect(saved).toEqual(geometry);
    if (saved) saved.outerHeight = 1;
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual(geometry);
    flushDashboardTileCacheStorage();
    const persisted: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    expect(persisted).toEqual({ version: 1, entries: { tile: [geometry] } });
    resetDashboardTileCacheMemory();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual(geometry);
  });

  test("coalesces repeated measurements and does not rehydrate geometry on every read", () => {
    const storage = installWindow();
    storage.setItem(storageKey, JSON.stringify({ version: 1, entries: { tile: [geometry] } }));
    const reads = spyOn(storage, "getItem");
    const parses = spyOn(JSON, "parse");
    const writes = spyOn(storage, "setItem");
    for (let index = 0; index < 20; index += 1) {
      writeDashboardTileGeometry(scope, "tile", { ...geometry, outerHeight: 660 + index });
      expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)?.outerHeight).toBe(660 + index);
    }
    expect(reads).toHaveBeenCalledTimes(1);
    expect(parses).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    flushDashboardTileCacheStorage();
    flushDashboardTileCacheStorage();
    expect(writes).toHaveBeenCalledTimes(1);
  });

  test.each([[0.25, 1], [600, 600], [5_000, 800]])("clamps guest frame height %s to %s without capping chrome height", (frameHeight, expected) => {
    installWindow();
    writeDashboardTileGeometry(scope, "tile", { ...geometry, frameHeight, outerHeight: 940 });
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual({ ...geometry, frameHeight: expected, outerHeight: 940 });
  });

  const invalid: Array<[string, Partial<DashboardTileGeometry>]> = [
    ["NaN width", { contentWidth: NaN }],
    ["infinite width", { contentWidth: Infinity }],
    ["negative width", { contentWidth: -1 }],
    ["hidden width", { contentWidth: 0 }],
    ["width rounding to zero", { contentWidth: 0.2 }],
    ["excessive width", { contentWidth: 10_001 }],
    ["NaN frame", { frameHeight: NaN }],
    ["infinite frame", { frameHeight: Infinity }],
    ["negative frame", { frameHeight: -1 }],
    ["hidden frame", { frameHeight: 0 }],
    ["NaN outer height", { outerHeight: NaN }],
    ["infinite outer height", { outerHeight: Infinity }],
    ["negative outer height", { outerHeight: -1 }],
    ["hidden outer height", { outerHeight: 0 }],
    ["excessive outer height", { outerHeight: 10_001 }],
    ["blank workspace", { workspaceId: " " }],
    ["NaN timestamp", { measuredAt: NaN }],
    ["infinite timestamp", { measuredAt: Infinity }],
    ["zero timestamp", { measuredAt: 0 }],
    ["negative timestamp", { measuredAt: -1 }],
    ["future timestamp", { measuredAt: geometry.measuredAt + 1 }],
    ["expired timestamp", { measuredAt: geometry.measuredAt - 24 * 60 * 60 * 1_000 - 1 }],
  ];

  test.each(invalid)("rejects %s without replacing a valid measurement", (_label, changes) => {
    installWindow();
    writeDashboardTileGeometry(scope, "tile", geometry);
    writeDashboardTileGeometry(scope, "tile", { ...geometry, ...changes });
    writeDashboardTileGeometry(scope, "invalid", { ...geometry, ...changes });
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual(geometry);
    expect(readDashboardTileGeometry(scope, "invalid", geometry.workspaceId)).toBeNull();
  });

  test.each([0, -1, NaN, Infinity, 10_001, 0.2])("does not turn invalid width %s into an initial estimate", (width) => {
    installWindow();
    writeDashboardTileGeometry(scope, "tile", geometry);
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, width)).toBeNull();
  });

  test("expires a hydrated measurement after 24 hours and removes it from storage", () => {
    const storage = installWindow();
    writeDashboardTileGeometry(scope, "tile", geometry);
    flushDashboardTileCacheStorage();
    setSystemTime(geometry.measuredAt + 24 * 60 * 60 * 1_000);
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual(geometry);
    setSystemTime(Date.now() + 1);
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(storageKey)).toBeNull();
    resetDashboardTileCacheMemory();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
  });

  const malformed: Array<[string, unknown]> = [
    ["corrupt JSON", "{"],
    ["unversioned", { entries: { tile: [geometry] } }],
    ["unknown version", { version: 2, entries: { tile: [geometry] } }],
    ["invalid entries", { version: 1, entries: [] }],
    ["non-array measurements", { version: 1, entries: { tile: geometry } }],
    ["invalid dimensions", { version: 1, entries: { tile: [{ ...geometry, frameHeight: "600" }] } }],
    ["expired measurement", { version: 1, entries: { tile: [{ ...geometry, measuredAt: geometry.measuredAt - 86_400_001 }] } }],
  ];

  test.each(malformed)("rejects persisted %s and allows a fresh measurement", (_label, value) => {
    const storage = installWindow();
    storage.setItem(storageKey, typeof value === "string" ? value : JSON.stringify(value));
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    writeDashboardTileGeometry(scope, "tile", geometry);
    flushDashboardTileCacheStorage();
    resetDashboardTileCacheMemory();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual(geometry);
  });

  test("keeps only the newest four workspace/width entries for a tile", () => {
    const storage = installWindow();
    const expected: DashboardTileGeometry[] = [];
    for (let index = 0; index < 6; index += 1) {
      const next = {
        ...geometry,
        workspaceId: index % 2 === 0 ? geometry.workspaceId : "workspace_other",
        contentWidth: 320 + index,
        measuredAt: geometry.measuredAt - 6 + index,
      };
      writeDashboardTileGeometry(scope, "tile", next);
      if (index >= 2) expected.unshift(next);
    }
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 320)).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile", "workspace_other", 321)).toBeNull();
    flushDashboardTileCacheStorage();
    const persisted: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    expect(persisted).toEqual({ version: 1, entries: { tile: expected } });
    resetDashboardTileCacheMemory();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 322)).toEqual(expected[3]);
  });

  test("bounds total width entries, not just the number of tiles, to 200 per scope", () => {
    const storage = installWindow();
    const expected = new Map<string, DashboardTileGeometry[]>();
    for (let tile = 0; tile < 51; tile += 1) {
      for (let width = 0; width < 4; width += 1) {
        const next = { ...geometry, contentWidth: 320 + width * 100, measuredAt: geometry.measuredAt - 204 + tile * 4 + width };
        const entryId = `tile_${tile}`;
        writeDashboardTileGeometry(scope, entryId, next);
        if (tile > 0) {
          const entries = expected.get(entryId) ?? [];
          entries.unshift(next);
          expected.set(entryId, entries);
        }
      }
    }
    expect(readDashboardTileGeometry(scope, "tile_0", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile_50", geometry.workspaceId, 620)?.contentWidth).toBe(620);
    flushDashboardTileCacheStorage();
    const persisted: unknown = JSON.parse(storage.getItem(storageKey) ?? "null");
    expect(persisted).toEqual({ version: 1, entries: Object.fromEntries(expected) });
  });

  test("also bounds stored input on hydration and ignores older measurements for the same width", () => {
    const storage = installWindow();
    const entries = Object.fromEntries(Array.from({ length: 201 }, (_, index) => [
      `tile_${index}`, [{ ...geometry, measuredAt: geometry.measuredAt - 201 + index }],
    ]));
    storage.setItem(storageKey, JSON.stringify({ version: 1, entries }));
    expect(readDashboardTileGeometry(scope, "tile_0", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile_200", geometry.workspaceId)).not.toBeNull();
    writeDashboardTileGeometry(scope, "tile_200", { ...geometry, frameHeight: 700 });
    writeDashboardTileGeometry(scope, "tile_200", { ...geometry, frameHeight: 200, measuredAt: geometry.measuredAt - 1 });
    expect(readDashboardTileGeometry(scope, "tile_200", geometry.workspaceId)?.frameHeight).toBe(700);
  });

  test("storage failures return a miss or an in-memory fallback without breaking measurements", () => {
    const storage = installWindow();
    spyOn(storage, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    spyOn(storage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    writeDashboardTileGeometry(scope, "tile", geometry);
    expect(() => flushDashboardTileCacheStorage()).not.toThrow();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toEqual(geometry);
  });

  test("deletion removes all widths and workspaces without reviving a pending measurement", () => {
    const storage = installWindow();
    writeDashboardTileGeometry(scope, "tile", geometry);
    writeDashboardTileGeometry(scope, "tile", { ...geometry, workspaceId: "workspace_other", contentWidth: 320 });
    writeDashboardTileGeometry(scope, "kept", geometry);
    flushDashboardTileCacheStorage();
    writeDashboardTileGeometry(scope, "tile", { ...geometry, outerHeight: 700 });
    removeDashboardTileGeometry(scope, "tile");
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile", "workspace_other", 320)).toBeNull();
    flushDashboardTileCacheStorage();
    resetDashboardTileCacheMemory();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileGeometry(scope, "kept", geometry.workspaceId)).toEqual(geometry);
    removeDashboardTileGeometry(scope, "kept");
    flushDashboardTileCacheStorage();
    expect(storage.getItem(storageKey)).toBeNull();
  });

  test("geometry storage updates and removal cancel stale writes without invalidating result data", () => {
    const storage = installWindow();
    writeDashboardTileCache(scope, "tile", resultCache);
    writeDashboardTileGeometry(scope, "tile", geometry);
    const external = { ...geometry, contentWidth: 320, outerHeight: 800 };
    storage.setItem(storageKey, JSON.stringify({ version: 1, entries: { tile: [external] } }));
    storageEvent(storage, storageKey);
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 320)).toEqual(external);
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId, 640)).toBeNull();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).not.toBeNull();
    expect(storage.getItem(storageKey)).toBe(JSON.stringify({ version: 1, entries: { tile: [external] } }));
    storage.removeItem(storageKey);
    storageEvent(storage, storageKey);
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    expect(readDashboardTileCache(scope, "tile")).toEqual(resultCache);
  });

  test("logout invalidates both caches and their queued persistence callbacks", () => {
    const storage = installWindow();
    writeDashboardTileCache(scope, "tile", resultCache);
    writeDashboardTileGeometry(scope, "tile", geometry);
    flushDashboardTileCacheStorage();
    const scheduled = spyOn(globalThis, "setTimeout");
    writeDashboardTileCache(scope, "tile", { ...resultCache, argumentsSignature: "pending" });
    writeDashboardTileGeometry(scope, "tile", { ...geometry, outerHeight: 700 });
    const pending = scheduled.mock.calls.map(([callback]) => callback);
    expect(pending).toHaveLength(2);
    clearDashboardTileCacheStorage(storage);
    expect(readDashboardTileCache(scope, "tile")).toBeNull();
    expect(readDashboardTileGeometry(scope, "tile", geometry.workspaceId)).toBeNull();
    for (const callback of pending) if (typeof callback === "function") callback();
    flushDashboardTileCacheStorage();
    expect(storage.getItem(scope)).toBeNull();
    expect(storage.getItem(storageKey)).toBeNull();
  });
});
