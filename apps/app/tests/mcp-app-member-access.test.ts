import { afterAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DenExternalMcpConnection } from "../src/app/lib/den";
import type { OpenworkMcpAppResource } from "../src/app/lib/openwork-server";
import type { McpAppOrigin } from "../src/components/chat/mcp-app-origin";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const { setMcpAppDocumentBackend } = await import("../src/app/lib/mcp-app-document-store");
const { DASHBOARD_TILE_CACHE_STORAGE_PREFIX, flushDashboardTileCacheStorage, resetDashboardTileCacheMemory } = await import("../src/app/lib/dashboard-cache-storage");
const { cachedMcpAppResult, rememberMcpAppResult } = await import("../src/app/lib/mcp-app-result-cache");
const { createMcpAppOpenLoads } = await import("../src/app/lib/mcp-app-open-loads");
const { loadDashboardTileDocument, readDashboardTileCache, rememberDashboardTileRead, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");
const { memberAccessCheckPending, memberAccessConfirmed, memberAccessKeys, noteInventoryRevision, reconcileMemberAccess, resetMemberAccessSession, setMemberAccessScope, trackMemberAccessCheck, waitForMemberAccessCheck } = await import("../src/react-app/domains/dashboard/mcp-app-member-access");

const ORG = "org_one";
const scope = { baseUrl: "https://den.example", organizationId: ORG, memberId: "member_one" };
const tiles = `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.member.org.built`;
const entry = "personal:orders";
const documents = new Map<string, string>();
setMcpAppDocumentBackend({
  read: async (key) => documents.get(key) ?? null,
  save: async (html, size) => { documents.set(size.key, html); },
  sizes: async () => [], remove: async (keys) => { for (const key of keys) documents.delete(key); }, clear: async () => { documents.clear(); },
});

function connection(overrides: Partial<DenExternalMcpConnection> = {}): DenExternalMcpConnection {
  return { id: "conn_mail", name: "Mail", url: "https://mail.example", authType: "oauth", credentialMode: "per_member", exposeDirectly: false,
    connected: true, connectedAt: null, connectedForMe: true, externalAccountId: "account-a", grantedScopes: ["read"], ...overrides };
}
const inventory = (connections: DenExternalMcpConnection[] = [connection()], plugins: string[] = ["plg_one"]) => ({
  connections, capabilities: { plugins: plugins.map((pluginId) => ({ pluginId, marketplaceId: "m", marketplaceName: "M", name: pluginId, description: null, files: [] })) },
});
const app: OpenworkMcpAppResource = { serverName: "orders", toolName: "open_app", resourceUri: "ui://orders/1", html: "<html>orders</html>", prefersBorder: false,
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } };
const origin = { client: { baseUrl: "http://localhost:1" }, workspaceId: "w", sessionId: null, readOnly: true } as unknown as McpAppOrigin;
const toolResult: CallToolResult = { content: [{ type: "text", text: "kept" }], _meta: { "openwork/readOnly": true, "openwork/providerIdentity": "provider-1" } };

function saveTile() {
  writeDashboardTileCache(tiles, entry, { argumentsSignature: "{}", cachedAt: Date.now(), workspaceId: "w", app,
    result: { content: [{ type: "text", text: "saved launch" }], structuredContent: { rows: 3 } } });
  rememberDashboardTileRead(tiles, entry, { name: "load_orders", arguments: {} }, { providerIdentity: "provider-1", result: { content: [{ type: "text", text: "stored" }] } });
}
const stored = () => {
  const tile = readDashboardTileCache(tiles, entry);
  return { reads: tile?.storedReads?.length ?? 0, launch: tile?.result.content.length ?? 0, html: tile?.app.html };
};
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const restart = () => { flushDashboardTileCacheStorage(); resetDashboardTileCacheMemory(); resetMemberAccessSession(); };

beforeEach(() => {
  documents.clear();
  localStorage.clear();
  resetDashboardTileCacheMemory();
  resetMemberAccessSession();
  localStorage.setItem("openwork.den.activeOrgId", ORG);
  localStorage.setItem("openwork.den.authToken", "token");
  setMemberAccessScope(scope);
});

test("access lists only what this member can actually use, with the account behind each connection", () => {
  expect(memberAccessKeys(inventory())).toEqual(["connection:conn_mail:account-a:", "connection:conn_mail:account-a::read", "plugin:plg_one"]);
  expect(memberAccessKeys(inventory([connection({ connected: false })], []))).toEqual([]);
  expect(memberAccessKeys(inventory([connection({ connectedForMe: false })], []))).toEqual([]);
  expect(memberAccessKeys(inventory([connection({ needsReconnect: true })], []))).toEqual([]);
  expect(memberAccessKeys(inventory([connection({ credentialHealth: "reconnect_required" })], []))).toEqual([]);
  expect(memberAccessKeys(inventory([connection({ credentialMode: "shared", connectedForMe: false, grantedScopes: [] })], []))).toEqual(["connection:conn_mail:account-a:"]);
});

test("a revision that moved with nothing lost clears nothing", () => {
  saveTile();
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess(scope, "r2", inventory());
  reconcileMemberAccess(scope, "r3", inventory());
  expect(stored()).toEqual({ reads: 1, launch: 1, html: app.html });
});

test("gaining access clears nothing", () => {
  saveTile();
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess(scope, "r2", inventory([connection(), connection({ id: "conn_new" })], ["plg_one", "plg_new"]));
  expect(stored().reads).toBe(1);
});

test("a connection's health changing while it still works clears nothing", () => {
  saveTile();
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess(scope, "r2", inventory([connection({ readiness: { status: "could_not_verify", checkedAt: "now", lastSuccessfulAt: null, reason: "busy" } })]));
  expect(stored().reads).toBe(1);
});

test("the first comparison has nothing to lose against", () => {
  saveTile();
  reconcileMemberAccess(scope, "r1", inventory([], []));
  expect(stored().reads).toBe(1);
});

test.each([
  ["a connection removed", inventory([])],
  ["a member's own account disconnected", inventory([connection({ connectedForMe: false })])],
  ["a provider revoking access, once Den notices", inventory([connection({ credentialHealth: "reconnect_required" })])],
  ["reconnecting as another account", inventory([connection({ externalAccountId: "account-b" })])],
  ["reconnecting to another tenant", inventory([connection({ tenantId: "tenant-b" })])],
  ["losing a granted scope", inventory([connection({ grantedScopes: [] })])],
  ["losing a plugin", inventory([connection()], [])],
])("%s clears what every App stored", async (_name, after) => {
  saveTile();
  await settled();
  await rememberMcpAppResult(origin, app, "load_orders", {}, toolResult);
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess(scope, "r2", after);
  expect(stored().reads).toBe(0);
  expect(stored().launch).toBe(0);
  expect(await cachedMcpAppResult(origin, app, "load_orders", {})).toBeNull();
});

test("clearing keeps the App document, which holds no member data, so reopening stays fast", async () => {
  saveTile();
  await settled();
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess(scope, "r2", inventory([]));
  expect(stored().html).toBe(app.html);
  expect(documents.size).toBe(1);
});

test("what an earlier load kept for a remount is forgotten too", async () => {
  const call = { serverName: "orders", resourceUri: app.resourceUri, name: "load_orders", args: {} };
  const load = async (key: string) => {
    let ran = false;
    await createMcpAppOpenLoads(key).load(call, async () => { ran = true; return toolResult; }, async () => true);
    return ran;
  };
  expect(await load("open")).toBe(true);
  expect(await load("open")).toBe(false);
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess(scope, "r2", inventory([]));
  expect(await load("open")).toBe(true);
});

test("a loss while the app was closed is caught at the next start", async () => {
  saveTile();
  await settled();
  reconcileMemberAccess(scope, "r1", inventory());
  restart();
  await loadDashboardTileDocument(tiles, entry);
  expect(stored().reads).toBe(1);
  reconcileMemberAccess(scope, "r2", inventory([]));
  expect(stored().reads).toBe(0);
});

test("an unreadable record clears nothing, and the next comparison starts fresh", () => {
  saveTile();
  localStorage.setItem(`${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.access.${JSON.stringify([scope.baseUrl, ORG, scope.memberId])}`, "{not json");
  reconcileMemberAccess(scope, "r1", inventory());
  expect(stored().reads).toBe(1);
});

test("each member and organization compares against its own record", () => {
  saveTile();
  reconcileMemberAccess(scope, "r1", inventory());
  reconcileMemberAccess({ ...scope, memberId: "member_two" }, "r1", inventory([]));
  reconcileMemberAccess({ ...scope, organizationId: "org_two" }, "r1", inventory([]));
  expect(stored().reads).toBe(1);
});

test("a new session has confirmed nothing until it compares", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  expect(memberAccessConfirmed()).toBe(true);
  resetMemberAccessSession();
  setMemberAccessScope(scope);
  expect(memberAccessConfirmed()).toBe(false);
});

test("another member in the same organization inherits nothing", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  setMemberAccessScope({ ...scope, memberId: "member_two" });
  expect(memberAccessConfirmed()).toBe(false);
});

test("a comparison made for someone else confirms nothing for the member signed in", () => {
  reconcileMemberAccess({ ...scope, memberId: "member_two" }, "r1", inventory());
  expect(memberAccessConfirmed()).toBe(false);
});

test("the same member on another Den inherits nothing", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  setMemberAccessScope({ ...scope, baseUrl: "https://other-den.example" });
  expect(memberAccessConfirmed()).toBe(false);
});

test("coming back to a member after someone else needs a new comparison", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  setMemberAccessScope({ ...scope, memberId: "member_two" });
  setMemberAccessScope(scope);
  expect(memberAccessConfirmed()).toBe(false);
});

test("nobody signed in confirms nothing, and comparing afterwards still needs the member named", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  setMemberAccessScope(null);
  expect(memberAccessConfirmed()).toBe(false);
  reconcileMemberAccess(scope, "r2", inventory());
  expect(memberAccessConfirmed()).toBe(false);
});

test("naming the same member again keeps the comparison", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  setMemberAccessScope({ ...scope });
  expect(memberAccessConfirmed()).toBe(true);
});

test("a revision unchanged since the last comparison confirms without reloading", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  resetMemberAccessSession();
  setMemberAccessScope(scope);
  noteInventoryRevision(scope, "r1");
  expect(memberAccessConfirmed()).toBe(true);
});

test.each([["a changed revision", "r2"], ["no revision from Den", null]])("%s does not confirm", (_name, revision) => {
  reconcileMemberAccess(scope, "r1", inventory());
  resetMemberAccessSession();
  setMemberAccessScope(scope);
  noteInventoryRevision(scope, revision);
  expect(memberAccessConfirmed()).toBe(false);
});

test("a record made without a revision never confirms one that is also missing", () => {
  reconcileMemberAccess(scope, null, inventory());
  resetMemberAccessSession();
  setMemberAccessScope(scope);
  noteInventoryRevision(scope, null);
  expect(memberAccessConfirmed()).toBe(false);
});

test("a comparison for another organization confirms nothing here", () => {
  reconcileMemberAccess({ ...scope, organizationId: "org_two" }, "r1", inventory());
  expect(memberAccessConfirmed()).toBe(false);
});

test("switching organization in settings stops confirming before the sync catches up", () => {
  reconcileMemberAccess(scope, "r1", inventory());
  localStorage.setItem("openwork.den.activeOrgId", "org_two");
  expect(memberAccessConfirmed()).toBe(false);
});

test("with no check running there is nothing to wait for", async () => {
  expect(memberAccessCheckPending()).toBe(false);
  await expect(waitForMemberAccessCheck()).resolves.toBeUndefined();
});

test("a check under way is pending until it finishes, and a failed one also ends", async () => {
  const check = Promise.withResolvers<void>();
  trackMemberAccessCheck(check.promise);
  expect(memberAccessCheckPending()).toBe(true);
  const waited = waitForMemberAccessCheck();
  check.reject(new Error("offline"));
  await waited;
  await settled();
  expect(memberAccessCheckPending()).toBe(false);
  expect(memberAccessConfirmed()).toBe(false);
});

test("a slow check gives up rather than holding the App back", async () => {
  trackMemberAccessCheck(new Promise(() => {}));
  const started = performance.now();
  await waitForMemberAccessCheck();
  const waited = performance.now() - started;
  expect(waited).toBeGreaterThanOrEqual(200);
  expect(waited).toBeLessThan(1_000);
});
