/** @jsxImportSource react */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const ORG = "org_sync";
const connection = (id: string) => ({ id, name: id, url: "https://mail.example", authType: "oauth", credentialMode: "per_member", exposeDirectly: false,
  connected: true, connectedAt: null, connectedForMe: true, externalAccountId: "account-a" });
let connections = [connection("conn_mail")];
let revision: string | null = "r1";
let outcome: "updated" | "failed" = "updated";
let inventoryLoads = 0;
let hold: Promise<void> | null = null;
let principalId = "member_one";

mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ verifiedIdentity: { principalId, organizationId: ORG } }),
}));
mock.module("../src/react-app/domains/cloud/inventory-revision", () => ({
  createInventoryRevisionGate: () => {
    let last: string | null = null;
    return { check: async () => ({ skip: revision !== null && last === revision, revision }), synced: (value: string | null) => { last = value; } };
  },
}));
mock.module("../src/react-app/domains/cloud/member-activity-sync", () => ({
  refreshMemberActivity: async (input: { onLoaded?: (loaded: unknown) => void }) => {
    inventoryLoads += 1;
    await hold;
    if (outcome === "updated") input.onLoaded?.({ capabilities: { plugins: [], skills: [], mcpServers: [], mcpStatuses: {} }, connections });
    return outcome;
  },
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useMemberActivitySync } = await import("../src/react-app/domains/cloud/use-member-activity-sync");
const { DASHBOARD_TILE_CACHE_STORAGE_PREFIX } = await import("../src/app/lib/dashboard-cache-storage");
const { readDashboardTileCache, rememberDashboardTileRead, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");
const { denSettingsChangedEvent } = await import("../src/app/lib/den-session-events");
const { memberAccessCheckPending, memberAccessConfirmed, resetMemberAccessSession } = await import("../src/react-app/domains/dashboard/mcp-app-member-access");
const { CLOUD_INVENTORY_CHANGED_EVENT } = await import("../src/react-app/domains/connections/cloud-inventory-cache");
const { dispatchProviderCatalogChanged } = await import("../src/app/lib/provider-events");

const tiles = `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.sync-test`;
const entry = "personal:orders";
function Sync() { useMemberActivitySync(true); return null; }
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
const storedReads = () => readDashboardTileCache(tiles, entry)?.storedReads?.length ?? 0;
async function mounted(run: (rerender: () => Promise<void>) => Promise<void>) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const rerender = async () => { await act(async () => root.render(<Sync key="sync" />)); };
  try {
    await rerender();
    await settle();
    await run(rerender);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}
const changed = async () => { await act(async () => { window.dispatchEvent(new Event(CLOUD_INVENTORY_CHANGED_EVENT)); }); await settle(); };
const catalogChanged = async (reason?: "native" | "reconnect") => {
  await act(async () => { dispatchProviderCatalogChanged({ baseUrl: "http://engine", ...(reason ? { reason } : {}) }); });
  await settle();
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("openwork.den.authToken", "token");
  localStorage.setItem("openwork.den.activeOrgId", ORG);
  connections = [connection("conn_mail")]; revision = "r1"; outcome = "updated"; inventoryLoads = 0; hold = null; principalId = "member_one";
  resetMemberAccessSession();
  writeDashboardTileCache(tiles, entry, { argumentsSignature: "{}", cachedAt: Date.now(), workspaceId: "w", result: { content: [] },
    app: { serverName: "orders", toolName: "open_app", resourceUri: "ui://orders/1", html: "<html></html>", prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } });
  rememberDashboardTileRead(tiles, entry, { name: "load_orders", arguments: {} }, { providerIdentity: "provider-1", result: { content: [] } });
});

test("the sync confirms access once it has compared a complete inventory", async () => {
  await mounted(async () => {
    expect(inventoryLoads).toBe(1);
    expect(memberAccessConfirmed()).toBe(true);
    expect(storedReads()).toBe(1);
  });
});

test("while the sync runs a saved tile can see a check is under way", async () => {
  const release = Promise.withResolvers<void>();
  hold = release.promise;
  await mounted(async () => {
    expect(memberAccessCheckPending()).toBe(true);
    release.resolve();
    await settle();
    expect(memberAccessCheckPending()).toBe(false);
  });
});

test("a failed sync confirms nothing", async () => {
  outcome = "failed";
  await mounted(async () => { expect(memberAccessConfirmed()).toBe(false); });
});

test("the next sync after a member loses a connection clears stored data", async () => {
  await mounted(async () => {
    connections = []; revision = "r2";
    await changed();
    expect(storedReads()).toBe(0);
  });
});

test("the next sync with nothing lost keeps stored data", async () => {
  await mounted(async () => {
    revision = "r2";
    await changed();
    expect(inventoryLoads).toBe(2);
    expect(storedReads()).toBe(1);
  });
});

test("another member signing in to the same organization is not confirmed until their own sync finishes", async () => {
  await mounted(async (rerender) => {
    expect(memberAccessConfirmed()).toBe(true);
    const release = Promise.withResolvers<void>();
    hold = release.promise;
    revision = "r2";
    principalId = "member_two";
    await rerender();
    expect(memberAccessConfirmed()).toBe(false);
    release.resolve();
    await settle();
    expect(memberAccessConfirmed()).toBe(true);
  });
});

test("a new account token stops confirming at once, before React verifies who it belongs to", async () => {
  await mounted(async () => {
    expect(memberAccessConfirmed()).toBe(true);
    localStorage.setItem("openwork.den.authToken", "another-token");
    await act(async () => { window.dispatchEvent(new CustomEvent(denSettingsChangedEvent)); });
    expect(memberAccessConfirmed()).toBe(false);
  });
});

test("a sync with no verified member clears who is signed in", async () => {
  await mounted(async (rerender) => {
    expect(memberAccessConfirmed()).toBe(true);
    principalId = "";
    await rerender();
    expect(memberAccessConfirmed()).toBe(false);
  });
});

test("a later start with the same revision confirms as soon as the revision is read", async () => {
  await mounted(async () => {});
  resetMemberAccessSession();
  outcome = "failed";
  await mounted(async () => { expect(memberAccessConfirmed()).toBe(true); });
});

test("a reopened engine event stream reloads only when Den's revision has moved", async () => {
  await mounted(async () => {
    await catalogChanged("reconnect");
    await catalogChanged("reconnect");
    expect(inventoryLoads).toBe(1);
    revision = "r2";
    await catalogChanged("reconnect");
    expect(inventoryLoads).toBe(2);
  });
});

test("a provider change reported by the engine reloads at once", async () => {
  await mounted(async () => {
    await catalogChanged("native");
    await catalogChanged();
    expect(inventoryLoads).toBe(3);
  });
});
