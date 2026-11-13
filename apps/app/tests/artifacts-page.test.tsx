/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { BuiltMcpAppCatalogEntry } from "../src/app/lib/built-mcp-app-catalog";
import type { SavedAppSummary } from "@openwork/types/workflows";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, useEffect } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createPortal } = await import("react-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function app(connectionId: string, title: string, isOwner: boolean): BuiltMcpAppCatalogEntry {
  return { connectionId, title, isOwner, description: null, serverName: "artifacts", toolName: "open_app", projectedToolName: "open_app", resourceUri: `ui://artifacts/${connectionId}`, pluginId: `plugin-${connectionId}`, pluginName: "Workspace", requiresApproval: false };
}
const initialApps = [app("overview", "Overview", true), app("queue", "Review queue", false)];
let apps = initialApps;
let ids: string[] = ["overview"];
let scope = "artifacts-test-member-org";
let verified = true;
let catalogReady = true;
let deletions: string[] = [];
let deleteFails = false;
let pageActive = true;
let launches: string[] = [];
let mounts = 0;
let createPrompts: string[] = [];
let fixChangedTool: ((tool: string) => Promise<void>) | undefined;
let featuresUsed: string[] = [];
const legacy: SavedAppSummary = { view: { id: "saved-view", configObjectId: "config", title: "Saved report", description: null, status: "active", activeRevisionId: null, revisions: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }, workflowTitle: "Saved report", canManage: true, onDashboard: false };

mock.module("../src/react-app/domains/dashboard/built-dashboard-apps", () => ({
  useBuiltDashboardApps: () => ({ ready: catalogReady, orgId: "org", client: { deleteBuiltMcpApp: async (orgId: string, appId: string) => { deletions.push(appId); if (deleteFails) throw new Error("Only a manager can delete this artifact."); apps = apps.filter((item) => item.connectionId !== appId); } }, setAdded: (id: string, added: boolean) => { ids = added ? [...ids, id] : ids.filter((item) => item !== id); }, apps: verified ? apps : [], ids, identityVerified: verified, cacheScopeKey: scope, scope: [scope], query: { isPending: false, isSuccess: true, isError: false }, setAdded: (id: string, added: boolean) => { ids = added ? [...ids, id] : ids.filter((item) => item !== id); } }),
}));
mock.module("../src/react-app/domains/apps/use-apps", () => ({
  useSavedApps: () => ({ identityVerified: verified, available: true, canManage: true, scope: [scope], query: { isSuccess: true, isError: false, data: { items: [legacy] } } }),
}));
mock.module("../src/react-app/domains/dashboard/mcp-app-tile", () => ({
  McpAppTile: ({ entry, cacheScopeKey, chromeTarget, renderActions, onFixChangedTool }: { entry: { id: string }; cacheScopeKey: string; chromeTarget?: HTMLElement | null; renderActions?: (props: { onRefresh?: () => void; refreshing: boolean }) => unknown; onFixChangedTool?: (tool: string) => Promise<void> }) => {
    fixChangedTool = onFixChangedTool;
    useEffect(() => { launches.push(`${cacheScopeKey}/${entry.id}`); mounts += 1; return () => { mounts -= 1; }; }, []);
    return <div data-live-artifact={entry.id}>Live artifact{chromeTarget ? createPortal(<><span role="status">Updating…</span>{renderActions?.({ onRefresh: () => {}, refreshing: false }) as never}</>, chromeTarget) : null}</div>;
  },
}));
mock.module("../src/react-app/domains/dashboard/dashboard-apps", () => ({ SavedDashboardApp: ({ app }: { app: SavedAppSummary }) => <div data-saved-artifact={app.view.id}>Saved artifact</div> }));
mock.module("../src/react-app/domains/apps/built-app-share-button", () => ({ BuiltAppShareDialog: ({ open }: { open: boolean }) => open ? createPortal(<div data-artifact-share-dialog>Share artifact</div>, document.body) : null }));
mock.module("../src/app/lib/den", () => ({ markFeatureUsed: (key: string) => { featuresUsed.push(key); } }));
const { ArtifactsPage } = await import("../src/react-app/domains/dashboard/artifacts-page");
const { rememberArtifactSelection } = await import("../src/react-app/domains/dashboard/artifacts-workspace");
const { readDashboardTileCache, removeDashboardTileCache, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");
let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement;

async function render() {
  await act(async () => {
    root?.render(<QueryClientProvider client={client}><ArtifactsPage active={pageActive} onCreateApp={async (prompt) => { createPrompts.push(prompt); }} /></QueryClientProvider>);
  });
}
let client: InstanceType<typeof QueryClient>;
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.getAttribute("aria-label") === label || item.textContent === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => {
  deletions = []; deleteFails = false;
  apps = initialApps; ids = ["overview"]; verified = true; catalogReady = true; pageActive = true; scope = "artifacts-test-member-org"; launches = []; mounts = 0; createPrompts = [];
  fixChangedTool = undefined; featuresUsed = [];
  rememberArtifactSelection(scope, null);
  rememberArtifactSelection("another-member-org", null);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root?.unmount()); root = null; host.remove(); client.clear(); });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

test("catalog lists unpinned and legacy apps without launching any app", async () => {
  await render();
  expect(host.textContent).toContain("Overview");
  expect(host.textContent).toContain("Review queue");
  expect(host.textContent).toContain("Saved report");
  expect(launches).toEqual([]);
  expect(mounts).toBe(0);
});

test("selection mounts only one live app and pin/unpin does not remount it", async () => {
  await render();
  await click("Open Overview");
  expect(launches).toEqual([`${scope}/personal:overview`]);
  expect(mounts).toBe(1);
  await click("Unpin"); await render();
  expect(launches).toHaveLength(1);
  await click("Pin"); await render();
  expect(launches).toHaveLength(1);
  await click("Open Review queue");
  expect(mounts).toBe(1);
  expect(launches).toEqual([`${scope}/personal:overview`, `${scope}/personal:queue`]);
});

test("returning to the narrow list keeps the selected live view mounted", async () => {
  await render(); await click("Open Overview");
  await click("Artifacts");
  expect(mounts).toBe(1);
  expect(launches).toHaveLength(1);
  await click("Open Overview");
  expect(mounts).toBe(1);
  expect(launches).toHaveLength(1);
});

test("navigation closes a portalled Share dialog without resetting the selected artifact", async () => {
  await render(); await click("Open Overview"); await click("Share");
  expect(document.querySelector("[data-artifact-share-dialog]")).not.toBeNull();
  pageActive = false; await render();
  expect(document.querySelector("[data-artifact-share-dialog]")).toBeNull();
  expect(mounts).toBe(1);
  pageActive = true; await render();
  expect(document.querySelector("[data-artifact-share-dialog]")).toBeNull();
  expect(launches).toHaveLength(1);
});

test("Open in chat references the same artifact without creating another view", async () => {
  await render(); await click("Open Overview");
  await click("Open in chat");
  expect(createPrompts).toHaveLength(1);
  expect(createPrompts[0]).toContain("artifact ID: overview");
  expect(createPrompts[0]).toContain("do not create a copy");
  expect(launches).toHaveLength(1);
});

test("revoked access unmounts the live app rather than selecting another", async () => {
  await render(); await click("Open Overview");
  apps = initialApps.filter((item) => item.connectionId !== "overview"); await render();
  expect(mounts).toBe(0);
  expect(launches).toHaveLength(1);
  expect(host.querySelector("[data-live-artifact]")).toBeNull();
});

function saveTile(id: string) {
  writeDashboardTileCache(scope, id, { argumentsSignature: "{}", cachedAt: Date.now(), workspaceId: "w", result: { content: [] },
    app: { serverName: "artifacts", toolName: "open_app", resourceUri: `ui://${id}`, html: "<html></html>", prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } });
}

test("an App the member lost leaves this device, and the rest stay", async () => {
  saveTile("personal:overview"); saveTile("personal:queue");
  await render();
  expect(readDashboardTileCache(scope, "personal:queue")).not.toBeNull();
  apps = initialApps.filter((item) => item.connectionId !== "queue"); await render();
  expect(readDashboardTileCache(scope, "personal:queue")).toBeNull();
  expect(readDashboardTileCache(scope, "personal:overview")).not.toBeNull();
  removeDashboardTileCache(scope, "personal:overview");
});

test("a catalog that has not loaded removes nothing", async () => {
  saveTile("personal:queue");
  catalogReady = false; apps = [];
  await render();
  expect(readDashboardTileCache(scope, "personal:queue")).not.toBeNull();
  removeDashboardTileCache(scope, "personal:queue");
});

const deletable = () => { apps = [{ ...initialApps[0]!, canDelete: true }, initialApps[1]!]; };
const pageButton = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent === label);
async function confirm(label: string) {
  const button = pageButton(label);
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => { button.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

test("Delete shows only on an artifact this member may delete", async () => {
  deletable();
  await render();
  await click("Open Review queue");
  expect(pageButton("Delete")).toBeUndefined();
  await click("Open Overview");
  expect(pageButton("Delete")).not.toBeUndefined();
});

test("Fix with agent is offered only for an App this member manages", async () => {
  deletable();
  await render(); await click("Open Overview");
  expect(fixChangedTool).toBeFunction();
  await click("Open Review queue");
  expect(fixChangedTool).toBeUndefined();
});

test("Fix with agent starts a conversation that updates the same App", async () => {
  deletable();
  await render(); await click("Open Overview");
  await act(async () => { await fixChangedTool?.("load_issues"); });
  expect(createPrompts).toHaveLength(1);
  expect(createPrompts[0]).toContain("“Overview” (artifact ID: overview)");
  expect(createPrompts[0]).toContain("“load_issues”");
  expect(createPrompts[0]).toContain("Do not create a copy");
  expect(featuresUsed).toEqual([]);
  expect(launches).toHaveLength(1);
});

test("an older deployment that does not say shows no Delete", async () => {
  await render(); await click("Open Overview");
  expect(pageButton("Delete")).toBeUndefined();
});

test("nothing is deleted until the member confirms, and Cancel leaves the artifact", async () => {
  deletable();
  await render(); await click("Open Overview");
  await confirm("Delete");
  expect(document.body.textContent).toContain("removes the artifact for everyone");
  expect(deletions).toEqual([]);
  await confirm("Cancel");
  expect(deletions).toEqual([]);
  expect(mounts).toBe(1);
});

test("deleting closes the artifact, unpins it, and clears what this device saved", async () => {
  deletable();
  writeDashboardTileCache(scope, "personal:overview", { argumentsSignature: "{}", cachedAt: Date.now(), workspaceId: "w", result: { content: [] },
    app: { serverName: "artifacts", toolName: "open_app", resourceUri: "ui://overview", html: "<html></html>", prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } });
  await render(); await click("Open Overview");
  await confirm("Delete"); await confirm("Delete artifact");
  await render();
  expect(deletions).toEqual(["overview"]);
  expect(ids).toEqual([]);
  expect(mounts).toBe(0);
  expect(readDashboardTileCache(scope, "personal:overview")).toBeNull();
  expect(host.textContent).not.toContain("Overview");
  expect(host.textContent).toContain("Select an artifact to open it.");
});

test("a refused delete says why and leaves the artifact open", async () => {
  deletable(); deleteFails = true;
  await render(); await click("Open Overview");
  await confirm("Delete"); await confirm("Delete artifact");
  expect(document.body.textContent).toContain("Only a manager can delete this artifact.");
  expect(mounts).toBe(1);
  expect(ids).toEqual(["overview"]);
});

test("selection survives parent remount but never crosses identity scope", async () => {
  await render(); await click("Open Overview");
  await act(async () => root?.unmount());
  root = createRoot(host); await render();
  expect(host.querySelector("[data-live-artifact]")?.getAttribute("data-live-artifact")).toBe("personal:overview");
  scope = "another-member-org"; await render();
  expect(mounts).toBe(0);
  expect(host.querySelector("[data-live-artifact]")).toBeNull();
});

test("unverified identity cannot keep a legacy or live artifact mounted", async () => {
  await render(); await click("Open Saved report");
  expect(host.querySelector("[data-saved-artifact]")).not.toBeNull();
  verified = false; await render();
  expect(host.querySelector("[data-saved-artifact]")).toBeNull();
});

test("New artifact opens the composer callback directly", async () => {
  await render(); await click("New artifact");
  expect(createPrompts).toHaveLength(1);
  expect(createPrompts[0]).toContain("Create and save one live artifact");
  expect(host.querySelector("[role=dialog]")).toBeNull();
  expect(launches).toEqual([]);
});

test("the open artifact's refresh state and action sit in the toolbar, which stays put while the artifact scrolls", async () => {
  await render();
  await click("Open Overview");
  const slot = host.querySelector("[data-artifact-host-chrome]");
  const body = host.querySelector("[data-artifact-detail-body]");
  expect(slot?.textContent).toContain("Updating…");
  expect(slot?.innerHTML).toContain("Refresh Overview");
  // The toolbar is outside the scrolling body, so it never scrolls away.
  expect(body?.contains(slot ?? null)).toBe(false);
  expect(body?.className).toContain("overflow-y-auto");
  expect(body?.querySelector('[data-live-artifact="personal:overview"]')).not.toBeNull();
});
