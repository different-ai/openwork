import { afterAll, afterEach, beforeEach, expect, mock, test, setSystemTime, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GeneratedArtifactViewRevision, SavedAppDetail } from "@openwork/types/workflows";

import type { DashboardTileActions } from "../src/react-app/domains/dashboard/dashboard-tile-shell";
import type { DenGrantedDashboard } from "../src/app/lib/den";
import type { DenAuthStatus } from "../src/react-app/domains/cloud/den-auth-provider";
import type { McpAppSandboxViewProps } from "../src/components/chat/mcp-app-frame";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { resetDashboardTileCacheMemory } from "../src/app/lib/dashboard-cache-storage";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);

const scope = ["fixture", "member", "org", "fixture-api"];
const writes = mock(async () => { throw new Error("Updating must not save, activate, delete or recreate an app"); });
let detail: SavedAppDetail;
let settings = { baseUrl: "fixture", apiBaseUrl: "fixture-api", authToken: "fixture-token", activeOrgId: "org" };
let authStatus: DenAuthStatus = "signed_in";
let memberId: string | null = "member";
const workspace = { workspaceId: "workspace", openworkServerClient: {} };
const client = {
  listSavedApps: mock(async (_orgId: string) => ({ enabled: true, sharingEnabled: false, items: [detail] })),
  listGrantedDashboards: mock(async (_orgId: string): Promise<DenGrantedDashboard[]> => []),
  getSavedApp: mock(async () => detail),
  saveApp: writes,
  deleteApp: writes,
  setAppOnDashboard: mock(async (_orgId: string, _appId: string, _added: boolean) => { await writes(); }),
};
const den = await import("../src/app/lib/den");
mock.module("../src/app/lib/den", () => ({ ...den, createDenClient: () => client, readDenSettings: () => settings }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ status: authStatus, isSignedIn: authStatus === "signed_in", user: memberId ? { id: memberId } : null }),
}));
mock.module("../src/react-app/shell/workspace-provider", () => ({ useWorkspace: () => workspace }));
let previewHeight: number | undefined = 720;
let previewReady = true;
let previewMounts = 0;
const previews = new Map<string, { props: McpAppSandboxViewProps; resize: (height: number) => void }>();
mock.module("../src/components/chat/mcp-app-frame", () => ({
  McpAppSandboxView: (props: McpAppSandboxViewProps) => {
    const [height, setHeight] = useState(() => previewHeight ?? props.initialHeight ?? 360);
    useLayoutEffect(() => {
      previewMounts += 1;
      if (previewReady) props.onReady?.();
    }, []);
    previews.set(props.app.resourceUri, { props, resize: (next) => {
      setHeight(Math.min(800, Math.max(1, Math.ceil(next))));
      props.onHeightChange?.(next);
    } });
    return <div data-preview data-presentation={props.presentation} style={{ height }}>Working preview</div>;
  },
}));

const { DashboardTileShell } = await import("../src/react-app/domains/dashboard/dashboard-tile-shell");
const refresh = mock(() => {});
mock.module("../src/react-app/domains/dashboard/mcp-app-tile", () => ({
  McpAppTile: ({ entry, cacheScopeKey, renderActions }: { entry: { title: string; toolName: string; launchArguments?: Record<string, unknown> }; cacheScopeKey: string; renderActions?: DashboardTileActions }) =>
    <DashboardTileShell title={entry.title} compact renderActions={renderActions} onRefresh={refresh} badge={<span>Updated just now</span>}>
      <div data-live-tool={entry.toolName} data-live-scope={cacheScopeKey} style={{ height: 720 }}>{JSON.stringify(entry.launchArguments)}</div>
    </DashboardTileShell>,
}));

mock.module("../src/react-app/domains/dashboard/dashboard-connection-card", () => ({
  DashboardConnectionCard: ({ onConnected }: { onConnected: () => void }) => <button data-connection onClick={onConnected}>Reconnect preview</button>,
}));

const { useViewerDay } = await import("../src/react-app/domains/apps/live-generated-app");
const { nextViewerDayBoundary, liveGeneratedAppEntry, liveGeneratedAppCacheScope, viewerLocalDate } = await import("../src/react-app/domains/apps/live-generated-app-model");
const { dashboardTileCacheScopeKey, readDashboardTileCache, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");
const { readDashboardTileGeometry, writeDashboardTileGeometry } = await import("../src/react-app/domains/dashboard/dashboard-tile-geometry");
const { DashboardApps } = await import("../src/react-app/domains/dashboard/dashboard-apps");
const { DashboardPage } = await import("../src/react-app/domains/dashboard/dashboard-page");
const { GeneratedAppPreview } = await import("../src/react-app/domains/apps/generated-app-preview");
const { AppArtifact } = await import("../src/react-app/domains/apps/app-artifact");

function unavailable(): SavedAppDetail {
  return {
    view: {
      id: "arv_exact_app", configObjectId: "cob_exact_workflow", title: "Weekly report", description: null,
      status: "active", activeRevisionId: "revision_saved", revisions: [],
      createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    },
    workflowTitle: "Weekly report workflow", canManage: true, onDashboard: true,
    revision: null, html: null, payload: null,
    previewNotice: "Les résultats ont changé.",
  };
}

let container: HTMLDivElement;
let root: Root;
let cache: QueryClient;
let launch = mock(async (_prompt: string) => {});

beforeEach(() => {
  detail = unavailable();
  settings = { baseUrl: "fixture", apiBaseUrl: "fixture-api", authToken: "fixture-token", activeOrgId: "org" };
  authStatus = "signed_in";
  memberId = "member";
  workspace.workspaceId = "workspace";
  previewHeight = 720;
  previewReady = true;
  previewMounts = 0;
  previews.clear();
  resetDashboardTileCacheMemory();
  window.localStorage.clear();
  writes.mockClear();
  refresh.mockClear();
  client.getSavedApp.mockClear();
  client.listSavedApps.mockClear().mockImplementation(async () => ({ enabled: true, sharingEnabled: false, items: [detail] }));
  client.listGrantedDashboards.mockClear().mockImplementation(async () => []);
  client.setAppOnDashboard.mockClear().mockImplementation(async () => { await writes(); });
  launch = mock(async (_prompt: string) => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  cache.clear();
  resetDashboardTileCacheMemory();
  mock.restore();
  expect(writes).not.toHaveBeenCalled();
});

afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});

function Location() { return <output data-location>{useLocation().pathname}</output>; }

async function render(surface: string, withLauncher = true) {
  cache.setQueryData(["saved-apps", ...scope], { enabled: true, sharingEnabled: false, items: [detail] });
  cache.setQueryData(["app-preview", ...scope, detail.view.id, undefined, undefined], detail);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  cache.setQueryData(["app-preview", ...scope, detail.view.id, undefined, undefined, zone, viewerLocalDate(zone, Date.now())], detail);
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter>
    <Location />
    {surface === "dashboard" ? <DashboardApps onCreateApp={launch} /> : <AppArtifact appId={detail.view.id} onAsk={withLauncher ? launch : undefined} />}
  </MemoryRouter></QueryClientProvider>));
}

async function renderPage() {
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter>
    <DashboardPage onCreateApp={launch} />
  </MemoryRouter></QueryClientProvider>));
}

function snapshotGeometryReference() {
  if (!detail.revision) throw new Error("Missing snapshot revision");
  return {
    scopeKey: `${dashboardTileCacheScopeKey(scope[1] ?? null, scope[2] ?? null)}.snapshots.${encodeURIComponent(JSON.stringify(scope))}`,
    entryId: JSON.stringify([detail.view.id, detail.revision.id, detail.revision.resourceUri]),
  };
}

function previewFrame() {
  if (!detail.revision) throw new Error("Missing snapshot revision");
  const frame = previews.get(detail.revision.resourceUri);
  if (!frame) throw new Error("Missing preview frame");
  return frame;
}

function previewGeometryFixture() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  spyOn(document, "hidden", "get").mockReturnValue(false);
  spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
  spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    const preview = this.hasAttribute("data-preview") ? this : this.querySelector<HTMLElement>("[data-preview]");
    const height = preview ? parseFloat(preview.style.height) + (preview === this ? 0 : 28) : 0;
    return new DOMRect(0, 0, 640, Math.max(height, parseFloat(this.style.minHeight) || 0));
  });
  return {
    async flush() {
      await act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        for (const callback of pending) callback(0);
      });
    },
  };
}

function findButton(text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === text);
}

function button(text: string) {
  const found = findButton(text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="App options for ${detail.view.title}"]`);
  if (!trigger) throw new Error("Missing app menu");
  await act(async () => trigger.click());
}

function updateMenuItem() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent === "Update app");
}

function expectRepairPrompt(prompt: string | undefined) {
  expect(prompt).toContain(`artifactViewId: ${detail.view.id}`);
  expect(prompt).toContain(`configObjectId: ${detail.view.configObjectId}`);
  expect(prompt).toContain("Read its existing source with read_artifact_view before editing");
  expect(prompt).toContain("Adapt the app to the latest workflow output");
  expect(prompt).toContain("Preserve the existing artifactViewId and configObjectId");
  expect(prompt).toContain("save_artifact_view");
  expect(prompt).toContain("do not recreate the app or workflow");
  expect(prompt).toContain("Show a draft preview");
  expect(prompt).toContain("explicitly choose Save");
  expect(prompt).toContain("Do not autoactivate");
}

test.each(["dashboard", "artifact"])("%s update button and menu draft the same identity-bound repair request", async (surface) => {
  await render(surface);
  expect(container.textContent).toContain(detail.previewNotice);
  expect(launch).not.toHaveBeenCalled();
  await act(async () => button("Update app").click());
  expect(launch).toHaveBeenCalledTimes(1);
  expectRepairPrompt(launch.mock.calls[0]?.[0]);
  await openMenu();
  const item = updateMenuItem();
  if (!item) throw new Error("Missing Update app menu item");
  await act(async () => item.click());
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch.mock.calls[1]?.[0]).toBe(launch.mock.calls[0]?.[0]);
});

test.each(["dashboard", "artifact"])("%s disables update while opening and supports retry after a launcher error", async (surface) => {
  const opening = Promise.withResolvers<void>();
  launch.mockImplementationOnce(() => opening.promise);
  await render(surface);
  await act(async () => button("Update app").click());
  expect(button("Opening conversation…").disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label^="App options"]')?.disabled).toBe(true);
  await act(async () => button("Opening conversation…").click());
  expect(launch).toHaveBeenCalledTimes(1);
  await act(async () => opening.reject(new Error("Workspace disconnected")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Workspace disconnected");
  expect(button("Update app").disabled).toBe(false);
  await act(async () => button("Update app").click());
  expect(launch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test.each(["dashboard", "artifact"])("%s viewers see the warning but no editing controls", async (surface) => {
  detail.canManage = false;
  await render(surface);
  expect(container.textContent).toContain(detail.previewNotice);
  expect(findButton("Update app")).toBeUndefined();
  if (surface === "dashboard") await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(Array.from(document.querySelectorAll('[role="menuitem"]')).some((item) => item.textContent === "Ask for changes")).toBe(false);
  expect(launch).not.toHaveBeenCalled();
});

test.each(["dashboard", "artifact"])("%s does not offer repair without a preview notice", async (surface) => {
  detail.previewNotice = null;
  await render(surface);
  expect(findButton("Update app")).toBeUndefined();
  await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
});

test.each(["dashboard", "artifact"])("%s leaves a working preview unchanged even when a notice is present", async (surface) => {
  workingDetail();
  await render(surface);
  expect(container.querySelector("[data-preview]")?.textContent).toBe("Working preview");
  expect(findButton("Update app")).toBeUndefined();
  await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
});

test("artifact without a conversation launcher leaves the warning read-only", async () => {
  await render("artifact", false);
  expect(container.textContent).toContain(detail.previewNotice);
  expect(findButton("Update app")).toBeUndefined();
  await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
});

test.each(["dashboard", "artifact"])("%s launches live saved apps through the MCP tile without a stored payload", async (surface) => {
  detail.view = { ...detail.view, dataMode: "live", revisions: [{
    id: "revision_saved", artifactViewId: detail.view.id, resourceUri: "ui://openwork/artifacts/fixture",
    buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "schema",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
    compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 13, retiredAt: null,
    createdAt: detail.view.createdAt,
  }] };
  detail.revision = detail.view.revisions[0];
  await render(surface);
  expect(container.querySelector("[data-live-tool]")?.getAttribute("data-live-tool")).toBe(`run_artifact_${detail.view.id}`);
  expect(container.querySelector("[data-live-tool]")?.textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(container.querySelector("[data-preview]")).toBeNull();
  expect(client.getSavedApp).not.toHaveBeenCalled();
});

test("draft connection errors replace payloads and reconnect refetches the exact revision with viewer zone", async () => {
  workingDetail();
  detail = { ...detail, html: "stale preview", runError: { connectionCard: {
    schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Calendar", state: "needs_connection",
    actor: "member", message: "Connect your calendar", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  } } };
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter>
    <AppArtifact appId={detail.view.id} revisionId="avr_draft" />
  </MemoryRouter></QueryClientProvider>));
  expect(container.querySelector("[data-connection]")).not.toBeNull();
  expect(container.querySelector("[data-preview]")).toBeNull();
  const expected = ["org", detail.view.id, { revisionId: "avr_draft", receiptId: undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }];
  expect(client.getSavedApp.mock.calls[0]).toEqual(expected);
  await act(async () => button("Reconnect preview").click());
  expect(client.getSavedApp.mock.calls[1]).toEqual(expected);
  client.getSavedApp.mockImplementationOnce(async () => { throw new Error("Preview unavailable"); });
  await act(async () => button("Reconnect preview").click());
  expect(container.textContent).toContain("Preview unavailable");
  expect(container.querySelector("[data-preview]")).toBeNull();
  expect(container.querySelector("[data-connection]")).toBeNull();
});

test("viewer day rechecks on focus after sleeping across midnight", async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = nextViewerDayBoundary(zone, Date.parse("2026-09-14T12:00:00Z"));
  const readDays: number[] = [];
  function Probe() { const viewer = useViewerDay(); readDays.push(viewer.now); return null; }
  try {
    setSystemTime(boundary - 1000);
    await act(async () => root.render(<Probe />));
    expect(readDays.at(-1)).toBe(boundary - 1000);
    setSystemTime(boundary + 1000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(readDays.at(-1)).toBe(boundary + 1000);
  } finally {
    await act(async () => root.render(null));
    setSystemTime();
  }
});

test("viewer day schedules midnight and advances without a focus event", async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = nextViewerDayBoundary(zone, Date.parse("2026-09-14T12:00:00Z"));
  let midnight: (() => void) | undefined;
  const original = globalThis.setTimeout;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay === 1000 && typeof handler === "function") midnight = () => handler(...args);
    return original(handler, delay, ...args);
  });
  const readDays: number[] = [];
  function Probe() { const viewer = useViewerDay(); readDays.push(viewer.now); return null; }
  try {
    setSystemTime(boundary - 1000);
    await act(async () => root.render(<Probe />));
    expect(midnight).toBeDefined();
    setSystemTime(boundary);
    await act(async () => { midnight?.(); });
    expect(readDays.at(-1)).toBe(boundary);
  } finally {
    await act(async () => root.render(null));
    timers.mockRestore();
    setSystemTime();
  }
});

test("yesterday's successful live payload cannot be loaded after midnight", () => {
  const revision: GeneratedArtifactViewRevision = { id: "avr_fixture", artifactViewId: detail.view.id, resourceUri: "ui://fixture/revision",
    buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "output",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
    compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 10,
    retiredAt: null, createdAt: "2026-09-14T00:00:00Z" };
  const midnight = Date.parse("2026-09-15T00:00:00Z");
  const yesterday = liveGeneratedAppEntry(detail.view, revision, "UTC", midnight - 1);
  const today = liveGeneratedAppEntry(detail.view, revision, "UTC", midnight);
  const cacheScope = liveGeneratedAppCacheScope(scope);
  writeDashboardTileCache(cacheScope, yesterday.id, {
    cachedAt: midnight - 1, workspaceId: "workspace", app: { serverName: "openwork-cloud", toolName: yesterday.toolName,
      resourceUri: revision.resourceUri, html: "Yesterday", prefersBorder: false, csp: revision.csp },
    result: { content: [{ type: "text", text: "Yesterday's private results" }] },
  });
  expect(readDashboardTileCache(cacheScope, yesterday.id, midnight)).not.toBeNull();
  expect(readDashboardTileCache(cacheScope, today.id, midnight)).toBeNull();
  window.localStorage.removeItem(cacheScope);
});

test.each(["live", "snapshot"])("%s saved tiles have no duplicate card or height cap and keep one accessible actions menu", async (mode) => {
  workingDetail();
  if (mode === "live") detail.view = { ...detail.view, dataMode: "live", revisions: detail.revision ? [detail.revision] : [] };
  await render("dashboard");
  const tile = container.querySelector<HTMLElement>("[data-personal-dashboard-app]");
  expect(tile).not.toBeNull();
  expect(tile?.closest("[data-dashboard-masonry]")).not.toBeNull();
  expect(tile?.querySelector("header")).toBeNull();
  expect(tile?.textContent).not.toContain("Open app");
  expect(tile?.className).not.toMatch(/border|overflow-hidden/);
  const preview = tile?.querySelector<HTMLElement>(mode === "live" ? "[data-live-tool]" : "[data-preview]");
  expect(preview?.style.height).toBe("720px");
  for (let parent = preview?.parentElement; parent && parent !== tile?.parentElement; parent = parent.parentElement) {
    expect(parent.className).not.toMatch(/max-h-|overflow-auto|overflow-y-auto/);
  }
  if (mode === "snapshot") expect(preview?.dataset.presentation).toBe("dashboard");
  const triggers = tile?.querySelectorAll<HTMLButtonElement>('[aria-label^="App options"]');
  expect(triggers?.length).toBe(1);
  expect(triggers?.[0]?.disabled).toBe(false);
  expect(triggers?.[0]?.tabIndex).toBe(0);
  expect(triggers?.[0]?.parentElement?.className).toContain("focus-within:opacity-100");
  await openMenu();
  expect(document.querySelector(`[aria-label="Remove ${detail.view.title} from dashboard"]`)).not.toBeNull();
  expect(document.querySelector(`[aria-label="Delete ${detail.view.title}"]`)).not.toBeNull();
  const open = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Open ${detail.view.title}"]`);
  expect(open).not.toBeNull();
  await act(async () => open?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe(`/dashboard/apps/${detail.view.id}`);
  if (mode === "live") {
    await openMenu();
    expect(document.body.textContent).toContain("Updated just now");
    const item = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Refresh ${detail.view.title}"]`);
    expect(item).not.toBeNull();
    await act(async () => item?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  }
});

test("saved app options open by keyboard and deletion still requires confirmation", async () => {
  workingDetail();
  await render("dashboard");
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="App options"]');
  if (!trigger) throw new Error("Missing app options");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const deletion = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Delete ${detail.view.title}"]`);
  expect(deletion).not.toBeNull();
  await act(async () => deletion?.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`Delete “${detail.view.title}”?`);
  expect(writes).not.toHaveBeenCalled();
  const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === "Cancel");
  await act(async () => cancel?.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test.each(["personal", "company"])("dashboard metadata starts in parallel and waits for both initial lists when %s resolves first", async (first) => {
  const personal = Promise.withResolvers<Awaited<ReturnType<typeof client.listSavedApps>>>();
  const company = Promise.withResolvers<DenGrantedDashboard[]>();
  const apps = { enabled: true, sharingEnabled: false, items: [detail] };
  const dashboards = [{ id: "company-board", name: "Company report", elements: [], updatedAt: null }];
  client.listSavedApps.mockImplementationOnce(() => personal.promise);
  client.listGrantedDashboards.mockImplementationOnce(() => company.promise);
  await renderPage();
  expect(client.listSavedApps).toHaveBeenCalledTimes(1);
  expect(client.listGrantedDashboards).toHaveBeenCalledTimes(1);
  expect(container.querySelector('[aria-label="Loading dashboard"]')).not.toBeNull();
  await act(async () => { if (first === "personal") personal.resolve(apps); else company.resolve(dashboards); });
  expect(container.querySelector('[aria-label="Loading dashboard"]')).not.toBeNull();
  expect(container.textContent).not.toContain(detail.view.title);
  expect(container.querySelector("[data-granted-dashboard]")).toBeNull();
  expect(client.getSavedApp).not.toHaveBeenCalled();
  await act(async () => { if (first === "personal") company.resolve(dashboards); else personal.resolve(apps); });
  expect(container.querySelector('[aria-label="Loading dashboard"]')).toBeNull();
  const sections = Array.from(container.querySelectorAll('section[aria-label="Your apps"], section[data-granted-dashboard]'));
  expect(sections).toHaveLength(2);
  expect(sections[0]?.getAttribute("aria-label")).toBe("Your apps");
  expect(sections[1]?.getAttribute("data-granted-dashboard")).toBe("company-board");
  expect(client.listSavedApps).toHaveBeenCalledTimes(1);
  expect(client.listGrantedDashboards).toHaveBeenCalledTimes(1);
});

test.each(["checking", "signed_out"])("dashboard does not reveal cached personal apps or request lists while auth is %s", async (status) => {
  authStatus = status === "checking" ? "checking" : "signed_out";
  cache.setQueryData(["saved-apps", ...scope], { enabled: true, sharingEnabled: false, items: [detail] });
  await renderPage();
  expect(container.textContent).not.toContain(detail.view.title);
  expect(container.querySelector("[data-personal-dashboard-app]")).toBeNull();
  expect(client.listSavedApps).not.toHaveBeenCalled();
  expect(client.listGrantedDashboards).not.toHaveBeenCalled();
  expect(client.getSavedApp).not.toHaveBeenCalled();
});

test("failed initial lists leave the loading gate and keep the existing personal retry control usable", async () => {
  client.listSavedApps.mockImplementation(async () => { throw new Error("Personal list unavailable"); });
  client.listGrantedDashboards.mockImplementation(async () => { throw new Error("Company list unavailable"); });
  await renderPage();
  expect(container.querySelector('[aria-label="Loading dashboard"]')).toBeNull();
  expect(container.textContent).toContain("Your apps could not be loaded.");
  expect(container.textContent).toContain("Your organization's dashboards could not be loaded right now.");
  client.listSavedApps.mockImplementation(async () => ({ enabled: true, sharingEnabled: false, items: [detail] }));
  await act(async () => button("Try again").click());
  expect(container.textContent).toContain(detail.view.title);
  expect(container.textContent).not.toContain("Your apps could not be loaded.");
  expect(container.querySelector('[aria-label="Loading dashboard"]')).toBeNull();
});

test.each(["baseUrl", "apiBaseUrl"])("managed tile cache and granted metadata include %s while consent stays separate", async (field) => {
  await renderPage();
  const board = container.querySelector<HTMLElement>("[data-dashboard-cache-scope]");
  const previousScope = board?.dataset.dashboardCacheScope;
  const consentScope = board?.dataset.dashboardConsentScope;
  expect(previousScope).toBeDefined();
  const company = Promise.withResolvers<DenGrantedDashboard[]>();
  client.listGrantedDashboards.mockImplementationOnce(() => company.promise);
  await act(async () => {
    settings = { ...settings, [field]: "other-deployment" };
    window.dispatchEvent(new Event(denSettingsChangedEvent));
  });
  expect(container.querySelector('[aria-label="Loading dashboard"]')).not.toBeNull();
  expect(container.querySelector("[data-personal-dashboard-app]")).toBeNull();
  await act(async () => company.resolve([]));
  const next = container.querySelector<HTMLElement>("[data-dashboard-cache-scope]");
  expect(next?.dataset.dashboardCacheScope).not.toBe(previousScope);
  expect(next?.dataset.dashboardConsentScope).toBe(consentScope);
  expect(cache.getQueryCache().findAll({ queryKey: ["den", "granted-dashboards"] })).toHaveLength(2);
});

test("snapshot dashboard restores the exact width before mounting its frame, records shrink and restores it on return", async () => {
  workingDetail();
  previewHeight = undefined;
  previewReady = false;
  const host = previewGeometryFixture();
  const reference = snapshotGeometryReference();
  const now = Date.now();
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, { workspaceId: "workspace", contentWidth: 640, frameHeight: 220, outerHeight: 248, measuredAt: now - 1 });
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, { workspaceId: "workspace", contentWidth: 320, frameHeight: 600, outerHeight: 628, measuredAt: now });
  await render("dashboard");
  expect(previewFrame().props.initialHeight).toBe(220);
  expect(previewFrame().props.origin.readOnly).toBe(true);
  expect(container.querySelector('[aria-label="Loading Weekly report"]')).not.toBeNull();
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "workspace", 640)?.measuredAt).toBe(now - 1);
  const frame = container.querySelector("[data-preview]");
  await act(async () => previewFrame().resize(100.1));
  await host.flush();
  expect(container.querySelector<HTMLElement>("[aria-busy]")?.style.minHeight).toBe("");
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "workspace", 640)).toMatchObject({ frameHeight: 101, outerHeight: 129 });
  await act(async () => previewFrame().props.onReady?.());
  expect(container.querySelector('[aria-label="Loading Weekly report"]')).toBeNull();
  expect(container.querySelector("[data-preview]")).toBe(frame);
  expect(previewMounts).toBe(1);
  await act(async () => root.render(null));
  await render("dashboard");
  expect(previewFrame().props.initialHeight).toBe(101);
  expect(previewMounts).toBe(2);
  expect(container.querySelector("[data-live-tool]")).toBeNull();
  expect(client.getSavedApp).not.toHaveBeenCalled();
});

test("snapshot metadata loading reserves a short remembered height without tall card chrome or a live call", async () => {
  workingDetail();
  if (!detail.revision) throw new Error("Missing snapshot revision");
  detail.view.revisions = [detail.revision];
  previewHeight = undefined;
  previewGeometryFixture();
  const reference = snapshotGeometryReference();
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, { workspaceId: "workspace", contentWidth: 640, frameHeight: 96, outerHeight: 124, measuredAt: Date.now() });
  const pending = Promise.withResolvers<SavedAppDetail>();
  client.getSavedApp.mockImplementationOnce(() => pending.promise);
  cache.setQueryData(["saved-apps", ...scope], { enabled: true, sharingEnabled: false, items: [detail] });
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter><DashboardApps onCreateApp={launch} /></MemoryRouter></QueryClientProvider>));
  expect(container.querySelector<HTMLElement>("[data-personal-dashboard-app]")?.style.minHeight).toBe("124px");
  expect(container.querySelector("[data-personal-dashboard-app] header")).toBeNull();
  expect(container.querySelector("[data-personal-dashboard-app] section")?.className).not.toContain("min-h-64");
  expect(container.textContent).toContain("Loading app…");
  expect(container.querySelector("[data-preview]")).toBeNull();
  await act(async () => pending.resolve(detail));
  expect(previewFrame().props.initialHeight).toBe(96);
  expect(container.querySelector<HTMLElement>("[data-personal-dashboard-app]")?.style.minHeight).toBe("");
  expect(client.getSavedApp).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-live-tool]")).toBeNull();
});

test("inline snapshot previews retain their unwrapped 360px default even with dashboard geometry available", async () => {
  workingDetail();
  const { html, payload, revision } = detail;
  if (!html || !payload || !revision) throw new Error("Missing working snapshot");
  previewHeight = undefined;
  const reference = snapshotGeometryReference();
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, { workspaceId: "workspace", contentWidth: 640, frameHeight: 700, outerHeight: 728, measuredAt: Date.now() });
  await act(async () => root.render(<GeneratedAppPreview html={html} payload={payload} revision={revision} title={detail.view.title} geometry={reference} />));
  expect(previewFrame().props.initialHeight).toBe(360);
  expect(previewFrame().props.presentation).toBe("inline");
  expect(previewFrame().props.onHeightChange).toBeUndefined();
  expect(container.querySelector("[data-preview]")?.parentElement).toBe(container);
  expect(container.querySelector("[aria-busy]")).toBeNull();
  expect(container.textContent).not.toContain("Updated ");
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "workspace", 640)?.frameHeight).toBe(700);
});

test.each(["workspace", "revision"])("snapshot preview geometry cannot cross a %s identity change", async (identity) => {
  workingDetail();
  previewHeight = undefined;
  previewGeometryFixture();
  const reference = snapshotGeometryReference();
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, { workspaceId: "workspace", contentWidth: 640, frameHeight: 512, outerHeight: 540, measuredAt: Date.now() });
  await render("dashboard");
  expect(previewFrame().props.initialHeight).toBe(512);
  if (identity === "workspace") workspace.workspaceId = "other-workspace";
  else {
    if (!detail.revision) throw new Error("Missing snapshot revision");
    detail.revision = { ...detail.revision, id: "revision_next", resourceUri: "ui://openwork/artifacts/next" };
    detail.view = { ...detail.view, activeRevisionId: detail.revision.id, revisions: [detail.revision] };
  }
  await render("dashboard");
  expect(previewFrame().props.initialHeight).toBe(360);
  expect(previewFrame().props.origin.workspaceId).toBe(workspace.workspaceId);
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "workspace", 640)?.frameHeight).toBe(512);
});

test("successful snapshot removal deletes geometry only after placement settles and preserves result and unrelated keys", async () => {
  workingDetail();
  const reference = snapshotGeometryReference();
  const geometry = { workspaceId: "workspace", contentWidth: 640, frameHeight: 220, outerHeight: 248, measuredAt: Date.now() };
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, geometry);
  writeDashboardTileGeometry(reference.scopeKey, reference.entryId, { ...geometry, workspaceId: "other-workspace", contentWidth: 320 });
  writeDashboardTileGeometry(reference.scopeKey, "other-tile", geometry);
  writeDashboardTileCache(reference.scopeKey, reference.entryId, {
    cachedAt: Date.now(), workspaceId: "workspace", app: { serverName: "reports", toolName: "report", resourceUri: "ui://report",
      html: "Saved report", prefersBorder: true, csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } },
    result: { content: [{ type: "text", text: "Saved result" }] },
  });
  window.localStorage.setItem("unrelated-consent-fixture", "keep");
  const placement = Promise.withResolvers<void>();
  client.setAppOnDashboard.mockImplementationOnce(async () => { await placement.promise; detail = { ...detail, onDashboard: false }; });
  await render("dashboard");
  await openMenu();
  const remove = document.querySelector<HTMLElement>(`[aria-label="Remove ${detail.view.title} from dashboard"]`);
  if (!remove) throw new Error("Missing remove action");
  await act(async () => remove.click());
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "workspace")).not.toBeNull();
  await act(async () => placement.resolve());
  expect(client.setAppOnDashboard).toHaveBeenCalledWith("org", detail.view.id, false);
  expect(container.querySelector("[data-personal-dashboard-app]")).toBeNull();
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "workspace")).toBeNull();
  expect(readDashboardTileGeometry(reference.scopeKey, reference.entryId, "other-workspace")).toBeNull();
  expect(readDashboardTileGeometry(reference.scopeKey, "other-tile", "workspace")).not.toBeNull();
  expect(readDashboardTileCache(reference.scopeKey, reference.entryId)).not.toBeNull();
  expect(window.localStorage.getItem("unrelated-consent-fixture")).toBe("keep");
});

function workingDetail() {
  detail.html = "<p>Report</p>";
  detail.revision = {
    id: "revision_saved", artifactViewId: detail.view.id, resourceUri: "ui://openwork/artifacts/fixture",
    buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "schema",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
    compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 13, retiredAt: null,
    createdAt: detail.view.createdAt,
  };
  detail.payload = {
    schemaVersion: "1", data: { count: 1 }, artifact: {
      title: detail.view.title, description: null, pluginId: "plugin", configObjectId: detail.view.configObjectId,
      configObjectVersionId: "version", receiptId: "receipt", automationRunId: null, source: "manual",
      generatedAt: detail.view.updatedAt, resultDigest: "result", rendererVersion: "codemode-markdown-v1",
      freshness: { state: "fresh", ageMs: 0 },
    },
  };
}
