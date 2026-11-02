import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { MCP_APP_INITIAL_RESULTS_META } from "@openwork/types/mcp-app";
import type { OpenworkMcpAppResource } from "../src/app/lib/openwork-server";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const { readDashboardTileCache, rememberDashboardTileRead, removeDashboardTileCache, savedLaunchResult, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");
const { flushDashboardTileCacheStorage, resetDashboardTileCacheMemory } = await import("../src/app/lib/dashboard-cache-storage");

const scope = "tile-cache-test";
const entry = "orders";
const read = { name: "load_orders", arguments: {} };
const NOW = Date.parse("2026-11-02T12:00:00.000Z");

function app(resourceUri = "ui://orders/1"): OpenworkMcpAppResource {
  return { serverName: "orders", toolName: "open_app", resourceUri, html: "<html></html>", prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } };
}
function save(overrides: { app?: OpenworkMcpAppResource; meta?: Record<string, unknown> } = {}) {
  writeDashboardTileCache(scope, entry, { argumentsSignature: "{}", cachedAt: Date.now(), workspaceId: "w", app: overrides.app ?? app(),
    result: { content: [], ...(overrides.meta ? { _meta: overrides.meta } : {}) } });
}
const kept = (text: string, providerIdentity = "provider-1") => ({ providerIdentity, result: { content: [{ type: "text", text }], _meta: { private: true } } });
const stored = () => readDashboardTileCache(scope, entry)?.storedReads ?? [];
const shown = () => {
  const cache = readDashboardTileCache(scope, entry);
  if (!cache) throw new Error("Missing saved tile");
  return savedLaunchResult(cache)._meta?.[MCP_APP_INITIAL_RESULTS_META] as Array<Record<string, unknown>> | undefined;
};

beforeEach(() => { removeDashboardTileCache(scope, entry); });

test("a stored read comes back in the launch-data shape an App already reads, without its provider identity", () => {
  save();
  rememberDashboardTileRead(scope, entry, read, kept("stored"), NOW);
  expect(shown()).toEqual([{ name: "load_orders", arguments: {}, loadedAt: new Date(NOW).toISOString(), result: { content: [{ type: "text", text: "stored" }] } }]);
});

test("with nothing stored the saved launch result is returned unchanged", () => {
  save({ meta: { kept: "as-is" } });
  const cache = readDashboardTileCache(scope, entry);
  if (!cache) throw new Error("Missing saved tile");
  expect(savedLaunchResult(cache)).toBe(cache.result);
});

test("the newer of launch data and a stored read wins for the same call, and other launch data stays", () => {
  const older = new Date(NOW - 60_000).toISOString();
  const newer = new Date(NOW + 60_000).toISOString();
  save({ meta: { [MCP_APP_INITIAL_RESULTS_META]: [{ name: "load_orders", arguments: {}, loadedAt: older, result: { content: [] } }, { name: "load_totals", arguments: {}, loadedAt: older, result: { content: [] } }] } });
  rememberDashboardTileRead(scope, entry, read, kept("stored"), NOW);
  expect(shown()?.map((item) => [item.name, item.loadedAt])).toEqual([["load_orders", new Date(NOW).toISOString()], ["load_totals", older]]);
  save({ meta: { [MCP_APP_INITIAL_RESULTS_META]: [{ name: "load_orders", arguments: {}, loadedAt: newer, result: { content: [] } }] } });
  expect(shown()?.map((item) => [item.name, item.loadedAt])).toEqual([["load_orders", newer]]);
});

test("a failed read forgets that read and leaves the others", () => {
  save();
  rememberDashboardTileRead(scope, entry, read, kept("orders"), NOW);
  rememberDashboardTileRead(scope, entry, { name: "load_totals", arguments: {} }, kept("totals"), NOW);
  rememberDashboardTileRead(scope, entry, read, null, NOW);
  expect(stored().map((item) => item.name)).toEqual(["load_totals"]);
  rememberDashboardTileRead(scope, entry, { name: "load_totals", arguments: {} }, null, NOW);
  expect(stored()).toEqual([]);
  expect(shown()).toBeUndefined();
});

test("the same tool with other arguments is a separate read", () => {
  save();
  rememberDashboardTileRead(scope, entry, { name: "load_orders", arguments: { page: 1 } }, kept("one"), NOW);
  rememberDashboardTileRead(scope, entry, { name: "load_orders", arguments: { page: 2 } }, kept("two"), NOW);
  expect(stored()).toHaveLength(2);
});

test("a result from another account drops everything read through the old one", () => {
  save();
  rememberDashboardTileRead(scope, entry, read, kept("first account"), NOW);
  rememberDashboardTileRead(scope, entry, { name: "load_totals", arguments: {} }, kept("second account", "provider-2"), NOW);
  expect(stored().map((item) => [item.name, item.providerIdentity])).toEqual([["load_totals", "provider-2"]]);
});

test("stored reads outlive a refresh of the launch but not a change of App", () => {
  save();
  rememberDashboardTileRead(scope, entry, read, kept("stored"), NOW);
  save();
  expect(stored()).toHaveLength(1);
  save({ app: app("ui://orders/2") });
  expect(stored()).toEqual([]);
});

test("a read too large to keep is dropped, along with its older copy", () => {
  save();
  rememberDashboardTileRead(scope, entry, read, kept("small"), NOW);
  rememberDashboardTileRead(scope, entry, read, kept("x".repeat(200_001)), NOW);
  expect(stored()).toEqual([]);
});

test("the oldest reads go first once together they exceed the budget", () => {
  save();
  for (const name of ["first", "second", "third"]) rememberDashboardTileRead(scope, entry, { name, arguments: {} }, kept("x".repeat(100_000)), NOW);
  expect(stored().map((item) => item.name)).toEqual(["second", "third"]);
});

test("nothing is stored for a tile that was never saved", () => {
  rememberDashboardTileRead(scope, entry, read, kept("stored"), NOW);
  expect(readDashboardTileCache(scope, entry)).toBeNull();
});

test("stored reads survive a restart, and malformed ones are dropped", () => {
  save();
  rememberDashboardTileRead(scope, entry, read, kept("stored"), NOW);
  flushDashboardTileCacheStorage();
  resetDashboardTileCacheMemory();
  expect(stored().map((item) => item.result.content)).toEqual([[{ type: "text", text: "stored" }]]);
  const raw = JSON.parse(localStorage.getItem(scope) ?? "{}");
  raw.$entries[entry].storedReads.push({ name: 7 }, { name: "x", arguments: {}, loadedAt: "now", providerIdentity: "p", result: { content: "text" } });
  localStorage.setItem(scope, JSON.stringify(raw));
  resetDashboardTileCacheMemory();
  expect(stored()).toHaveLength(1);
});
