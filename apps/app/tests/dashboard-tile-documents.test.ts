import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenworkMcpAppResource } from "../src/app/lib/openwork-server";
import type { McpAppDocumentBackend, McpAppDocumentSize } from "../src/app/lib/mcp-app-document-store";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const { mcpAppDocuments, setMcpAppDocumentBackend } = await import("../src/app/lib/mcp-app-document-store");
const { clearDashboardTileCacheStorage, DASHBOARD_TILE_CACHE_STORAGE_PREFIX, flushDashboardTileCacheStorage, resetDashboardTileCacheMemory } = await import("../src/app/lib/dashboard-cache-storage");
const { dashboardTileDocumentPending, loadDashboardTileDocument, readDashboardTileCache, rememberDashboardTileRead, removeDashboardTileCache, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");

const documents = new Map<string, string>();
const sizes = new Map<string, McpAppDocumentSize>();
let saves = 0;
let failing = false;
const guard = () => { if (failing) throw new Error("IndexedDB unavailable"); };
const fake: McpAppDocumentBackend = {
  async read(key) { guard(); return documents.get(key) ?? null; },
  async save(html, size) { guard(); saves += 1; documents.set(size.key, html); sizes.set(size.key, size); },
  async sizes() { guard(); return [...sizes.values()]; },
  async remove(keys) { guard(); for (const key of keys) { documents.delete(key); sizes.delete(key); } },
  async clear() { guard(); documents.clear(); sizes.clear(); },
};
setMcpAppDocumentBackend(fake);

const scope = `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.documents-test`;
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
function app(html: string, resourceUri = "ui://orders/1"): OpenworkMcpAppResource {
  return { serverName: "orders", toolName: "open_app", resourceUri, html, prefersBorder: false,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } };
}
const save = (entry: string, html: string) => writeDashboardTileCache(scope, entry, {
  argumentsSignature: "{}", cachedAt: Date.now(), workspaceId: "w", app: app(html), result: { content: [{ type: "text", text: entry }] } });
function restart() {
  flushDashboardTileCacheStorage();
  resetDashboardTileCacheMemory();
}

beforeEach(() => {
  documents.clear(); sizes.clear(); saves = 0; failing = false;
  localStorage.clear();
  resetDashboardTileCacheMemory();
});

test("App HTML stays out of localStorage, and saved results stay in it", async () => {
  save("orders", "<html>orders</html>");
  await settled();
  flushDashboardTileCacheStorage();
  const raw = localStorage.getItem(scope) ?? "";
  expect(raw).not.toContain("<html>orders</html>");
  expect(raw).toContain('"text":"orders"');
  expect([...documents.values()]).toEqual(["<html>orders</html>"]);
});

test("a restart restores the saved tile once its document is back from IndexedDB", async () => {
  save("orders", "<html>orders</html>");
  await settled();
  restart();
  expect(dashboardTileDocumentPending(scope, "orders")).toBe(true);
  expect(readDashboardTileCache(scope, "orders")).toBeNull();
  await loadDashboardTileDocument(scope, "orders");
  expect(dashboardTileDocumentPending(scope, "orders")).toBe(false);
  expect(readDashboardTileCache(scope, "orders")?.app.html).toBe("<html>orders</html>");
});

test("what the App last loaded survives a restart along with its document", async () => {
  save("orders", "<html>orders</html>");
  await settled();
  rememberDashboardTileRead(scope, "orders", { name: "load_orders", arguments: {} }, { providerIdentity: "provider-1", result: { content: [{ type: "text", text: "stored" }] } });
  restart();
  await loadDashboardTileDocument(scope, "orders");
  const restored = readDashboardTileCache(scope, "orders");
  expect(restored?.app.html).toBe("<html>orders</html>");
  expect(restored?.storedReads?.map((read) => read.result.content)).toEqual([[{ type: "text", text: "stored" }]]);
});

test("a tile with nothing saved has no document to wait for", () => {
  expect(dashboardTileDocumentPending(scope, "never-saved")).toBe(false);
});

test("a missing document means an ordinary open, not a failure", async () => {
  save("orders", "<html>orders</html>");
  await settled();
  restart();
  documents.clear();
  await loadDashboardTileDocument(scope, "orders");
  expect(readDashboardTileCache(scope, "orders")).toBeNull();
});

test("IndexedDB failing never stops a tile saving or opening", async () => {
  failing = true;
  save("orders", "<html>orders</html>");
  await settled();
  expect(readDashboardTileCache(scope, "orders")?.app.html).toBe("<html>orders</html>");
  restart();
  await expect(loadDashboardTileDocument(scope, "orders")).resolves.toBeUndefined();
  expect(readDashboardTileCache(scope, "orders")).toBeNull();
});

test("far more Apps than the old budget allowed all stay saved", async () => {
  const large = "x".repeat(600_000);
  for (let index = 0; index < 12; index += 1) save(`app-${index}`, `${large}${index}`);
  await settled();
  restart();
  for (let index = 0; index < 12; index += 1) {
    await loadDashboardTileDocument(scope, `app-${index}`);
    expect(readDashboardTileCache(scope, `app-${index}`)?.app.html.endsWith(`${index}`)).toBe(true);
  }
});

test("refreshing a tile does not write its unchanged document again", async () => {
  save("orders", "<html>orders</html>");
  save("orders", "<html>orders</html>");
  await settled();
  expect(saves).toBe(1);
  save("orders", "<html>new revision</html>");
  await settled();
  expect(saves).toBe(2);
});

test("a tile restored after a restart saves its document again only if it changed", async () => {
  save("orders", "<html>orders</html>");
  await settled();
  restart();
  await loadDashboardTileDocument(scope, "orders");
  saves = 0;
  save("orders", "<html>orders</html>");
  await settled();
  expect(saves).toBe(0);
});

test("removing a tile removes its document", async () => {
  save("orders", "<html>orders</html>");
  await settled();
  removeDashboardTileCache(scope, "orders");
  await settled();
  expect(documents.size).toBe(0);
});

test("signing out clears every document", async () => {
  save("orders", "<html>orders</html>");
  save("totals", "<html>totals</html>");
  await settled();
  clearDashboardTileCacheStorage(localStorage);
  await settled();
  expect(documents.size).toBe(0);
  expect(readDashboardTileCache(scope, "orders")).toBeNull();
});

test("documents are kept per member and organization scope", async () => {
  await mcpAppDocuments.save("member-a", "orders", "<html>a</html>");
  expect(await mcpAppDocuments.read("member-a", "orders")).toBe("<html>a</html>");
  expect(await mcpAppDocuments.read("member-b", "orders")).toBeNull();
});

test("the oldest documents go once the store is over its size, and any over a week old go too", async () => {
  const now = Date.parse("2026-11-02T12:00:00.000Z");
  await mcpAppDocuments.save("s", "old", "x".repeat(40 * 1024 * 1024), now - 2_000);
  await mcpAppDocuments.save("s", "middle", "x".repeat(20 * 1024 * 1024), now - 1_000);
  await mcpAppDocuments.save("s", "new", "x".repeat(20 * 1024 * 1024), now);
  expect(await mcpAppDocuments.read("s", "old")).toBeNull();
  expect(await mcpAppDocuments.read("s", "middle")).not.toBeNull();
  await mcpAppDocuments.save("s", "later", "small", now + 7 * 24 * 60 * 60_000);
  expect(await mcpAppDocuments.read("s", "new")).toBeNull();
  expect(await mcpAppDocuments.read("s", "later")).toBe("small");
});

test("entries saved by an earlier version, with HTML in localStorage, still restore", () => {
  localStorage.setItem(scope, JSON.stringify({
    $html: { h0: "<html>older</html>" },
    $entries: { orders: { cachedAt: Date.now(), workspaceId: "w", argumentsSignature: "{}", result: { content: [] }, app: { ...app(""), html: undefined, htmlRef: "h0" } } },
  }));
  resetDashboardTileCacheMemory();
  expect(readDashboardTileCache(scope, "orders")?.app.html).toBe("<html>older</html>");
});
