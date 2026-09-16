/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkMcpAppToolResult, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { mcpAppResolutionRetryDelayMs } from "../src/app/lib/mcp-app-resolution";
import { resolveDashboardMcpApp } from "../src/react-app/domains/dashboard/dashboard-mcp-app-resolution";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";
import type { McpAppSandboxViewProps } from "../src/components/chat/mcp-app-frame";
import type { DashboardMcpAppEntry } from "../src/react-app/domains/dashboard/granted-dashboard-store";
import type { GeneratedArtifactView, GeneratedArtifactViewRevision } from "@openwork/types/workflows";
import { liveGeneratedAppCacheScope, liveGeneratedAppEntry, nextViewerDayBoundary } from "../src/react-app/domains/apps/live-generated-app-model";
import { DASHBOARD_AUTO_REFRESH_INTERVAL_MS, readDashboardTileCache, writeDashboardTileCache } from "../src/react-app/domains/dashboard/dashboard-tile-cache";
import { resetDashboardTileCacheMemory } from "../src/app/lib/dashboard-cache-storage";
import * as launchScheduler from "../src/react-app/domains/dashboard/dashboard-launch-scheduler";
import * as tileGeometry from "../src/react-app/domains/dashboard/use-dashboard-tile-geometry";

let sandboxView: McpAppSandboxViewProps | undefined;
let automaticallyReady = true;

// Exercise the mounted tile and real action lifetime without starting an iframe or provider.
mock.module("@/components/chat/mcp-app-frame", () => ({
  McpAppSandboxView: (props: McpAppSandboxViewProps) => {
    sandboxView = props;
    const { app, origin, presentation, initialHeight } = props;
    const actionsRef = useRef<ReturnType<typeof createMcpAppActions> | null>(null);
    const [message, setMessage] = useState("");
    const [startingHeight] = useState(initialHeight);
    const callbacks = useRef(props);
    callbacks.current = props;
    useLayoutEffect(() => {
      const actions = createMcpAppActions(origin, app);
      actionsRef.current = actions;
      if (automaticallyReady) callbacks.current.onReady?.();
      return () => { actions.dispose(); actionsRef.current = null; };
    }, [origin, app]);
    return <div data-sandbox-view data-presentation={presentation} data-initial-height={startingHeight} data-update-mode={props.updateMode}>
      <button disabled={origin.readOnly} onClick={() => {
        void actionsRef.current?.callTool("read_detail").then(() => setMessage("Lease usable"), error => setMessage(error.message));
      }}>App action</button>
      <span data-action-result>{message}</span>
      <span data-rendered-result>{JSON.stringify(props.result)}</span>
    </div>;
  },
}));

GlobalRegistrator.register({ url: "http://localhost/" });
afterEach(() => {
  resetDashboardTileCacheMemory();
  window.localStorage.clear();
  sandboxView = undefined;
  automaticallyReady = true;
});
afterAll(() => GlobalRegistrator.unregister());
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
const { McpAppTile } = await import("../src/react-app/domains/dashboard/mcp-app-tile");
let viewerScope = ["fixture-host", "fixture-member", "fixture-org"];
mock.module("../src/react-app/domains/apps/use-apps", () => ({
  useAppsClient: () => ({ client: {}, orgId: viewerScope[2], scope: viewerScope }),
}));
const { LiveGeneratedApp } = await import("../src/react-app/domains/apps/live-generated-app");
const liveRevision: GeneratedArtifactViewRevision = {
  id: "avr_fixture", artifactViewId: "arv_fixture", resourceUri: "ui://openwork/artifacts/arv_fixture/avr_fixture",
  buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "output",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
  compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 10,
  retiredAt: null, createdAt: "2026-09-14T00:00:00.000Z",
};
const liveView: GeneratedArtifactView = {
  id: "arv_fixture", configObjectId: "cob_fixture", title: "Fixture", description: null, dataMode: "live",
  status: "active", activeRevisionId: liveRevision.id, revisions: [liveRevision],
  createdAt: liveRevision.createdAt, updatedAt: liveRevision.createdAt,
};

const resource: OpenworkMcpAppResource = {
  serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html", html: "<p>Fixture</p>",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const noRelease = async () => { throw new Error("No lease should be released"); };

type TileCallRequest = Parameters<OpenworkServerClient["callMcpAppTool"]>[1];

function continuityResource(index: number): OpenworkMcpAppResource {
  return { ...resource, launchId: `continuity-${index}`, refresh: { resourceDigest: "a".repeat(64), expiresAt: Date.now() + 30 * 60_000 } };
}

function continuityFixture(options: {
  guarded?: boolean;
  entry?: Partial<DashboardMcpAppEntry>;
  resolve?: (index: number) => Promise<OpenworkMcpAppResource | null>;
  call?: (request: TileCallRequest, index: number) => Promise<OpenworkMcpAppToolResult>;
} = {}) {
  const resolutions: string[] = [];
  const calls: Array<{ workspaceId: string; request: TileCallRequest }> = [];
  const released: string[] = [];
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async workspaceId => {
      resolutions.push(workspaceId);
      return { app: options.resolve ? await options.resolve(resolutions.length)
        : options.guarded === false ? { ...resource, launchId: `continuity-${resolutions.length}` } : continuityResource(resolutions.length) };
    },
    callMcpAppTool: async (workspaceId, request) => {
      calls.push({ workspaceId, request });
      return options.call ? options.call(request, calls.length) : {
        content: [{ type: "text", text: `result-${calls.length}` }],
        structuredContent: { version: calls.length }, _meta: { fixture: true }, isError: false,
      };
    },
    releaseMcpApp: async (_workspaceId, id) => { released.push(id); return { released: true }; },
  };
  const entry: DashboardMcpAppEntry = {
    kind: "mcp", id: "continuity", title: "Fixture", serverName: resource.serverName, toolName: resource.toolName,
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri, autoLaunch: true, launchArguments: { query: "saved" },
    ...options.entry,
  };
  return { client, entry, resolutions, calls, released };
}

async function mountContinuityTile(fixture: ReturnType<typeof continuityFixture>, initial: {
  client?: OpenworkServerClient | null;
  workspaceId?: string;
  entry?: DashboardMcpAppEntry;
  cacheScopeKey?: string;
  fallbackEndpoints?: Array<{ client: OpenworkServerClient; workspaceId: string }>;
  strict?: boolean;
} = {}) {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let settings = {
    client: initial.client === undefined ? fixture.client : initial.client,
    workspaceId: initial.workspaceId ?? "fixture", entry: initial.entry ?? fixture.entry,
    cacheScopeKey: initial.cacheScopeKey ?? "continuity-scope", fallbackEndpoints: initial.fallbackEndpoints,
    strict: initial.strict ?? false,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let mounted = true;
  let autoLaunchDisabled = 0;
  const render = async (next: Partial<typeof settings> = {}) => {
    settings = { ...settings, ...next };
    const tile = <WorkspaceProvider client={null} openworkServerClient={settings.client} workspaceId={settings.workspaceId} selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={settings.entry} cacheScopeKey={settings.cacheScopeKey} fallbackEndpoints={settings.fallbackEndpoints}
        onAutoLaunchDisabled={() => { autoLaunchDisabled++; }} />
    </WorkspaceProvider>;
    await act(async () => root.render(settings.strict ? <StrictMode>{tile}</StrictMode> : tile));
  };
  const dispose = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  };
  try { await render(); } catch (error) { await dispose(); throw error; }
  return { container, render, dispose, disabledCount: () => autoLaunchDisabled };
}

async function compactRefreshItem(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="App options for Fixture"]');
  if (!trigger) throw new Error("Missing compact app menu trigger");
  expect(container.querySelector('button[aria-label="Refresh Fixture"]')).toBeNull();
  await act(async () => { trigger.focus(); trigger.click(); });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Refresh Fixture"]');
  if (!item) throw new Error("Missing Refresh menu item");
  return item;
}

async function refreshCompactTile(container: HTMLElement) {
  const item = await compactRefreshItem(container);
  await act(async () => item.click());
}

test("live generated actions share refresh state without remounting the menu or resetting the launch on rerender", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let launches = 0;
  let resolutions = 0;
  const pending = Promise.withResolvers<{ content: [] }>();
  const released: string[] = [];
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `actions-${++resolutions}` } }),
    callMcpAppTool: async () => ++launches === 1 ? { content: [] } : pending.promise,
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = async () => {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
      <LiveGeneratedApp view={liveView} revision={liveRevision} renderActions={({ onRefresh, refreshing, badge }) =>
        <div data-custom-actions><button aria-label="Custom refresh" onClick={onRefresh} disabled={refreshing}>Refresh</button>{badge}</div>} />
    </WorkspaceProvider>));
  };
  try {
    await render();
    const actions = container.querySelector("[data-custom-actions]");
    const view = container.querySelector("[data-sandbox-view]");
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Custom refresh"]');
    expect(button).not.toBeNull();
    expect(container.querySelector("header")).toBeNull();
    await act(async () => sandboxView?.onHeightChange?.(720));
    await render();
    expect(container.querySelector("[data-custom-actions]")).toBe(actions);
    expect(container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(launches).toBe(1);
    expect(released).toEqual([]);
    await act(async () => button?.click());
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("refreshing");
    expect(container.querySelector("[data-custom-actions]")).toBe(actions);
    expect(sandboxView?.initialHeight).toBe(720);
    await act(async () => pending.reject(new Error("Fixture refresh unavailable")));
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector("[data-custom-actions]")).toBe(actions);
    expect(container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(button?.disabled).toBe(false);
    expect(container.querySelector('[data-dashboard-cache-state="failed"]')).not.toBeNull();
    expect(container.textContent).toContain("showing last good data");
    expect(launches).toBe(2);
    expect(released).toEqual(["actions-2"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
  expect(released).toEqual(["actions-2", "actions-1"]);
  window.localStorage.removeItem(liveGeneratedAppCacheScope(viewerScope));
});

test("bounds retries to transient discovery failures", () => {
  for (const code of ["server_unavailable", "mcp_unreachable"]) {
    const cause = new OpenworkServerError(503, code, "starting");
    expect(mcpAppResolutionRetryDelayMs(cause, 0)).toBe(1_000);
    expect(mcpAppResolutionRetryDelayMs(cause, 1)).toBe(3_000);
    expect(mcpAppResolutionRetryDelayMs(cause, 2)).toBeNull();
  }
  for (const code of ["tool_denied", "tool_resource_mismatch"]) {
    expect(mcpAppResolutionRetryDelayMs(new OpenworkServerError(422, code, "denied"), 0)).toBeNull();
  }
  expect(mcpAppResolutionRetryDelayMs(new Error("unknown failure"), 0)).toBeNull();
});

test.each([false, true])("recovers or stops after three discovery attempts (exhausted: %j)", async (exhausted) => {
  let attempts = 0;
  const waits: number[] = [];
  const failure = new OpenworkServerError(503, "mcp_unreachable", "starting");
  const endpoint = {
    workspaceId: "workspace-1",
    client: { releaseMcpApp: noRelease, resolveMcpApp: async () => {
      attempts += 1;
      if (exhausted || attempts < 3) throw failure;
      return { app: resource };
    } },
  };
  const resolving = resolveDashboardMcpApp({
    endpoints: [endpoint], projectedToolName: "fixture_render", expected: resource,
    wait: async (delay) => { waits.push(delay); },
  });
  if (exhausted) await expect(resolving).rejects.toBe(failure);
  else expect(await resolving).toEqual({ endpoint, app: resource });
  expect(attempts).toBe(3);
  expect(waits).toEqual([1_000, 3_000]);
});

test("tries another workspace before waiting and never retries deterministic failures", async () => {
  let attempts = 0;
  const failure = new OpenworkServerError(422, "tool_resource_mismatch", "resource moved");
  const first = { workspaceId: "first", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => { attempts += 1; throw failure; } } };
  const second = { workspaceId: "second", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => ({ app: resource }) } };
  const options = {
    projectedToolName: "fixture_render", expected: resource,
    wait: async () => { throw new Error("must not retry"); },
  };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [first, second] })).toEqual({ endpoint: second, app: resource });
  await expect(resolveDashboardMcpApp({ ...options, endpoints: [first] })).rejects.toBe(failure);
  expect(attempts).toBe(2);
  let transientAttempts = 0;
  const transient = { workspaceId: "transient", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => {
    if (++transientAttempts < 3) throw new OpenworkServerError(503, "mcp_unreachable", "starting");
    return { app: resource };
  } } };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [transient, first], wait: async () => {} })).toEqual({ endpoint: transient, app: resource });
  expect(attempts).toBe(3);
  expect(transientAttempts).toBe(3);
});

test.each([
  { serverName: "other-server" },
  { toolName: "other-tool" },
  { resourceUri: "ui://fixture/other.html" },
])("releases a mismatched saved identity without exposing launch arguments: %j", async (mismatch) => {
  const released: string[] = [];
  const references: unknown[] = [];
  const lookalike = { workspaceId: "lookalike", client: {
    resolveMcpApp: async (_workspace: string, _name: string, launch: unknown, context: unknown) => {
      references.push({ launch, context });
      return { app: { ...resource, ...mismatch, launchId: "lookalike-lease" } };
    },
    releaseMcpApp: async (_workspace: string, id: string) => { released.push(id); return { released: true }; },
  } };
  const matching = { workspaceId: "matching", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => ({ app: resource }) } };
  const options = {
    projectedToolName: "fixture_render", expected: resource,
    wait: async () => { throw new Error("identity mismatch must not retry"); },
  };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike, matching] })).toEqual({ endpoint: matching, app: resource });
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike] })).toBeNull();
  const launch = { connectionId: "emc_fixture", toolName: resource.toolName, resourceUri: resource.resourceUri, arguments: { privateInput: "saved-input" } };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike], launch })).toBeNull();
  expect(references).toEqual([
    { launch: undefined, context: { sessionId: null, readOnly: false } },
    { launch: undefined, context: { sessionId: null, readOnly: false } },
    { launch: { ...launch, arguments: {} }, context: { sessionId: null, readOnly: false } },
  ]);
  expect(released).toEqual(["lookalike-lease", "lookalike-lease", "lookalike-lease"]);
});

test.each(["resolve", "wait"])("stops discovery and releases late leases when ownership ends during %s", async (phase) => {
  let active = true;
  let attempts = 0;
  const released: string[] = [];
  const endpoint = { workspaceId: "owner", client: {
    resolveMcpApp: async () => {
      attempts += 1;
      if (phase === "wait") throw new OpenworkServerError(503, "server_unavailable", "starting");
      active = false;
      return { app: { ...resource, launchId: "late-lease" } };
    },
    releaseMcpApp: async (_workspace: string, id: string) => { released.push(id); return { released: true }; },
  } };
  expect(await resolveDashboardMcpApp({
    endpoints: [endpoint], expected: resource, projectedToolName: "fixture_render",
    isActive: () => active, wait: async () => { active = false; },
  })).toBeNull();
  expect(attempts).toBe(1);
  expect(released).toEqual(phase === "resolve" ? ["late-lease"] : []);
});

test.each(["manual", "automatic", "background-refresh", "forbidden", "repeated", "churn", "unmount", "endpoint", "scope", "persisted"])("launch approval policy without a secondary modal: %s", async (mode) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const confirmSpy = spyOn(window, "confirm").mockReturnValue(false);
  const calls: unknown[] = [];
  let approvedLaunches = 0;
  let autoLaunchDisabled = 0;
  let autoLaunchEnabled = 0;
  let providerActions = 0;
  let finishChallenge: (() => void) | undefined;
  const challenge = new Promise<void>(resolve => { finishChallenge = resolve; });
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "launch-fixture" } }),
    callMcpAppTool: async (workspaceId, request) => {
      calls.push({ workspaceId, request });
      if (mode === "forbidden") throw new OpenworkServerError(403, "tool_denied", "Forbidden");
      if (!request.approved) await challenge;
      if (mode === "repeated" || !request.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required");
      providerActions += 1;
      return { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = {
    kind: "mcp", id: "approval-tile", title: "Fixture", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
    autoLaunch: mode === "automatic", launchApproved: mode === "persisted", requiresApproval: mode === "manual", launchArguments: { query: "saved input" },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let mounted = true;
  let connected = true;
  let scope = "approval-cache";
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={connected ? client : null} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={entry} cacheScopeKey={scope}
      onApprovedLaunch={() => { approvedLaunches++; }}
      onAutoLaunchDisabled={() => { autoLaunchDisabled++; }}
      onAutoLaunchEnabled={() => { autoLaunchEnabled++; }} />
  </WorkspaceProvider>);
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  const request = {
    launchId: "launch-fixture", sessionId: null, serverName: "fixture", name: "render",
    resourceUri: resource.resourceUri, arguments: structuredClone(entry.launchArguments),
    ...(mode === "persisted" ? { approved: true } : {}),
  };
  try {
    await act(async () => render());
    if (mode !== "automatic") {
      expect(calls).toEqual([]);
      expect(container.querySelector("header")?.textContent).toContain("Fixture");
      expect(container.querySelector('[aria-label="App options for Fixture"]')).toBeNull();
      if (mode === "manual") expect(container.textContent).toContain("This app modifies data when it runs, so it only runs when you ask.");
      await act(async () => button("Run Fixture").click());
    }
    expect(calls).toEqual([{ workspaceId: "fixture", request }]);
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(providerActions).toBe(mode === "persisted" ? 1 : 0);
    const retried = ["manual", "background-refresh", "repeated", "churn"].includes(mode);
    if (entry.launchArguments) entry.launchArguments.query = "changed after request";
    if (mode === "unmount") { await act(async () => root.unmount()); mounted = false; }
    else if (mode === "endpoint") { connected = false; await act(async () => render()); }
    else if (mode === "scope") { scope = "another-principal"; await act(async () => render()); }
    else if (mode === "churn") {
      entry.autoLaunch = true;
      await act(async () => render());
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(1);
    }
    await act(async () => { finishChallenge?.(); });
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(calls).toEqual((retried ? [false, true] : [false]).map(approved => ({
      workspaceId: "fixture", request: { ...request, ...(approved ? { approved: true } : {}) },
    })));
    expect(providerActions).toBe(["manual", "background-refresh", "churn", "persisted"].includes(mode) ? 1 : 0);
    expect(approvedLaunches).toBe(0);
    expect(autoLaunchDisabled).toBe(["manual", "automatic", "background-refresh", "repeated", "churn"].includes(mode) ? 1 : 0);
    expect(autoLaunchEnabled).toBe(0);
    if (mode === "automatic") {
      expect(button("Run Fixture").disabled).toBe(false);
      expect(container.querySelector("[data-action-result]")).toBeNull();
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(1);
      expect(autoLaunchDisabled).toBe(1);
    } else if (mode === "manual" || mode === "churn") {
      expect(container.querySelector("[data-action-result]")).not.toBeNull();
      entry.autoLaunch = true;
      await act(async () => render());
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(2);
      expect(providerActions).toBe(1);
      expect(container.querySelector("header")).toBeNull();
      await refreshCompactTile(container);
      expect(calls).toEqual([
        { workspaceId: "fixture", request },
        { workspaceId: "fixture", request: { ...request, approved: true } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" } } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" }, approved: true } },
      ]);
      expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
      expect(providerActions).toBe(2);
      expect(autoLaunchDisabled).toBe(2);
      expect(approvedLaunches).toBe(0);
      expect(autoLaunchEnabled).toBe(0);
    } else if (mode === "background-refresh") {
      entry.autoLaunch = true;
      await act(async () => render());
      expect(calls).toHaveLength(2);
      const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1_000);
      try {
        await act(async () => { window.dispatchEvent(new Event("focus")); });
      } finally {
        nowSpy.mockRestore();
      }
      expect(calls).toEqual([
        { workspaceId: "fixture", request },
        { workspaceId: "fixture", request: { ...request, approved: true } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" } } },
      ]);
      expect(providerActions).toBe(1);
      expect(autoLaunchDisabled).toBe(2);
      expect(autoLaunchEnabled).toBe(0);
      expect(button("Run Fixture").disabled).toBe(false);
      expect(container.querySelector("[data-action-result]")).toBeNull();
      expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    } else if (mode === "forbidden" || mode === "repeated") {
      expect(container.textContent).toContain(mode === "forbidden" ? "Forbidden" : "Approval required");
      expect(container.querySelector("[data-action-result]")).toBeNull();
    }
    expect(confirmSpy).not.toHaveBeenCalled();
  } finally {
    if (mounted) await act(async () => root.unmount());
    confirmSpy.mockRestore();
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("a mounted tile retains its lease across fallback refreshes, but releases on owner removal, refresh and unmount", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const leases = new Set<string>();
  const released: string[] = [];
  const calls: string[] = [];
  let resolutions = 0;
  let finishFirstResolution: (() => void) | undefined;
  const firstResolution = new Promise<void>(resolve => { finishFirstResolution = resolve; });
  const primary: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://primary.invalid" }),
    resolveMcpApp: async (_workspace, _tool, launch) => {
      expect(launch?.arguments).toEqual({});
      return { app: null };
    } };
  const owner: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://owner.invalid" }),
    resolveMcpApp: async (_workspace, _tool, launch, context) => {
      expect(launch?.arguments).toEqual({});
      expect(context).toEqual({ sessionId: null, readOnly: false });
      const launchId = `launch-${++resolutions}`;
      leases.add(launchId);
      if (resolutions === 1) await firstResolution;
      return { app: { ...resource, launchId } };
    },
    callMcpAppTool: async (workspaceId, request) => {
      expect(workspaceId).toBe("owner-workspace");
      if (!request.launchId || !leases.has(request.launchId)) throw new Error("Lease revoked");
      if (request.name === "render") expect(request.arguments).toEqual({ query: "saved input" });
      calls.push(request.name);
      return { content: [] };
    },
    releaseMcpApp: async (workspaceId, launchId) => {
      expect(workspaceId).toBe("owner-workspace");
      released.push(launchId);
      return { released: leases.delete(launchId) };
    },
  };
  const unrelated: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://unrelated.invalid" }),
    resolveMcpApp: async () => { throw new Error("Must not relaunch through an unrelated workspace"); } };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "tile", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri, title: "Fixture", autoLaunch: true,
    connectionId: "emc_fixture", launchArguments: { query: "saved input" } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (includeOwner = true, includeUnrelated = false) => {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={primary} workspaceId="primary" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey="fixture-cache" fallbackEndpoints={[
        ...(includeOwner ? [{ client: owner, workspaceId: "owner-workspace" }] : []),
        ...(includeUnrelated ? [{ client: unrelated, workspaceId: "unrelated-workspace" }] : []),
      ]} />
    </WorkspaceProvider>));
  };
  const button = (selector: string) => {
    const found = container.querySelector<HTMLButtonElement>(selector);
    if (!found) throw new Error(`Missing button ${selector}`);
    return found;
  };
  try {
    await render();
    expect(resolutions).toBe(1);
    await render();
    await render(true, true);
    expect(calls).toEqual([]);
    await act(async () => { finishFirstResolution?.(); });
    const actionButton = button("button:not([aria-label])");
    await render();
    await render(true, true);
    expect(button("button:not([aria-label])")).toBe(actionButton);
    expect(released).toEqual([]);
    expect(resolutions).toBe(1);
    await act(async () => actionButton.click());
    expect(container.querySelector("[data-action-result]")?.textContent).toBe("Lease usable");
    expect(calls).toEqual(["render", "read_detail"]);

    await render(false, true);
    expect(released).toEqual(["launch-1"]);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(readDashboardTileCache("fixture-cache", entry.id)).toBeNull();
    await render(true, true);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(resolutions).toBe(1);
    await act(async () => button('[aria-label="Refresh Fixture"]').click());
    expect(resolutions).toBe(2);
    expect(button("button:not([aria-label])").disabled).toBe(false);
    await refreshCompactTile(container);
    expect(resolutions).toBe(3);
    expect(released).toEqual(["launch-1", "launch-2"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
  expect(released).toEqual(["launch-1", "launch-2", "launch-3"]);
  expect(leases.size).toBe(0);
});

test.each(["sandbox", "refresh", "teardown"])("healthy tiles retain height and restore explicit recovery after %s failure or closure without repeating launch", async mode => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const released: string[] = [];
  let resolutions = 0;
  let launches = 0;
  let failRefresh = false;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: `compact-${++resolutions}` } }),
    callMcpAppTool: async () => {
      launches++;
      if (failRefresh) throw new OpenworkServerError(503, "server_unavailable", "Refresh temporarily unavailable");
      return { content: [] };
    },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const entry: DashboardMcpAppEntry = {
    kind: "mcp", id: `compact-${mode}`, title: "Fixture", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri, autoLaunch: true,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = async () => {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey={`compact-cache-${mode}`} />
    </WorkspaceProvider>));
  };
  const view = () => {
    const node = container.querySelector<HTMLElement>("[data-sandbox-view]");
    if (!node) throw new Error("Missing mocked sandbox view");
    return node;
  };
  const expectHealthy = () => {
    expect(container.querySelector("header")).toBeNull();
    expect(container.textContent).not.toContain("Fixture");
    expect(container.textContent).not.toContain("Updated just now");
    expect(container.querySelector('[aria-label="Refresh Fixture"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reload Fixture"]')).toBeNull();
    expect(container.querySelector("[data-dashboard-entry]")?.getAttribute("aria-label")).toBe("Fixture");
    expect(container.querySelector('[aria-label="App options for Fixture"]')).not.toBeNull();
    expect(view().dataset.presentation).toBe("dashboard");
  };
  try {
    await render();
    expectHealthy();
    const shell = container.querySelector("[data-dashboard-entry]");
    const initialView = view();
    expect(initialView.hasAttribute("data-initial-height")).toBe(false);
    expect(sandboxView?.onHeightChange).toBeFunction();
    await act(async () => sandboxView?.onHeightChange?.(73));
    await render();
    expect(view()).toBe(initialView);
    expect(resolutions).toBe(1);
    expect(launches).toBe(1);
    await refreshCompactTile(container);
    expectHealthy();
    const refreshedView = view();
    const stableParent = refreshedView.parentElement;
    expect(refreshedView).not.toBe(initialView);
    expect(refreshedView.dataset.initialHeight).toBe("73");
    expect(resolutions).toBe(2);
    expect(launches).toBe(2);
    expect(released).toEqual(["compact-1"]);

    if (mode === "sandbox") {
      expect(sandboxView?.onError).toBeFunction();
      await act(async () => sandboxView?.onError?.());
      expect(view()).toBe(refreshedView);
      expect(view().parentElement).toBe(stableParent);
      expect(released).toEqual(["compact-1", "compact-2"]);
      expect(container.querySelector("[data-dashboard-loading]")).toBeNull();
    } else if (mode === "refresh") {
      failRefresh = true;
      await refreshCompactTile(container);
      expect(container.querySelector('[data-dashboard-cache-state="failed"]')).not.toBeNull();
      expect(view()).toBe(refreshedView);
      expect(container.querySelector<HTMLButtonElement>("button:not([aria-label])")?.disabled).toBe(false);
      expect(released).toEqual(["compact-1", "compact-3"]);
    } else {
      expect(sandboxView?.onRequestTeardown).toBeFunction();
      await act(async () => sandboxView?.onRequestTeardown?.());
      expect(container.textContent).toContain("This app closed its view. Use refresh to launch it again.");
      expect(container.querySelector("[data-sandbox-view]")).toBeNull();
      expect(released).toEqual(["compact-1", "compact-2"]);
    }
    const expectedLaunches = mode === "refresh" ? 3 : 2;
    expect(container.querySelector("[data-dashboard-entry]")).toBe(shell);
    if (mode === "refresh") expect(container.querySelector("header")).toBeNull();
    else {
      expect(container.querySelector("header")?.textContent).toContain("Fixture");
      expect(container.querySelector('[aria-label="App options for Fixture"]')).toBeNull();
    }
    const recovery = mode === "refresh" ? await compactRefreshItem(container)
      : container.querySelector<HTMLButtonElement>('header button[aria-label="Refresh Fixture"]');
    if (!recovery) throw new Error("Missing recovery refresh");
    expect(recovery.getAttribute("aria-disabled")).not.toBe("true");
    expect(recovery.hasAttribute("disabled")).toBe(false);
    await render();
    await render();
    expect(resolutions).toBe(expectedLaunches);
    expect(launches).toBe(expectedLaunches);
    failRefresh = false;
    await act(async () => recovery.click());
    expectHealthy();
    expect(view().dataset.initialHeight).toBe("73");
    expect(resolutions).toBe(expectedLaunches + 1);
    expect(launches).toBe(expectedLaunches + 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
  expect([...released].sort()).toEqual(Array.from({ length: resolutions }, (_, index) => `compact-${index + 1}`).sort());
});

test.each(["result", "transport", "metadata", "text"])("live setup failures render a native connection card and evict the last good result (%s)", async (failureMode) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const liveResource = { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture" };
  let needsSetup = false;
  let calls = 0;
  const connection = {
    schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Calendar", state: "needs_connection",
    actor: "member", message: "Connect your calendar", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  };
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async (_workspace, name) => {
      expect(name).toBe("openwork-cloud_run_artifact_arv_fixture");
      return { app: { ...liveResource, launchId: "live-lease" } };
    },
    callMcpAppTool: async (_workspace, request) => {
      calls++;
      expect(request.name).toBe("run_artifact_arv_fixture");
      expect(request.arguments).toEqual({ timeZone: "Asia/Tokyo" });
      if (needsSetup && failureMode === "transport") throw new OpenworkServerError(403, "connection_required", "Connect your calendar", { connectionAction: connection });
      if (needsSetup && failureMode === "metadata") return { isError: true, content: [], _meta: { connectionAction: connection } };
      if (needsSetup && failureMode === "text") return { isError: true, content: [{ type: "text", text: JSON.stringify({ connectionAction: connection }) }], structuredContent: { status: "blocked" } };
      return needsSetup ? { isError: true, content: [], structuredContent: { connectionAction: connection } } : { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "live-setup", title: "Fixture", serverName: liveResource.serverName,
    toolName: liveResource.toolName, projectedToolName: `openwork-cloud_${liveResource.toolName}`, resourceUri: liveResource.resourceUri,
    autoLaunch: true, launchArguments: { timeZone: "Asia/Tokyo" } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey="live-setup-scope" />
    </WorkspaceProvider>));
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    needsSetup = true;
    await refreshCompactTile(container);
    expect(calls).toBe(2);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(container.querySelector('[data-testid="desktop-connection-card"]')?.textContent).toContain("Calendar");
    expect(container.querySelector('button[aria-label="Connect Calendar"]')).not.toBeNull();
    expect(readDashboardTileCache("live-setup-scope", entry.id)).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("live-setup-scope");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["result", "connection"])("switching viewers never exposes the prior viewer %s", async (initialState) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  let calls = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_scope", launchId: "scoped-lease" } }),
    callMcpAppTool: async () => {
      if (++calls !== 1) return pending.promise;
      return initialState === "result" ? { content: [] } : { isError: true, content: [], structuredContent: { connectionAction: {
        schemaVersion: "1", connectionId: "emc_scope", connectionName: "Calendar", state: "needs_connection",
        actor: "member", message: "Connect your calendar", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
      } } };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "viewer-scope", title: "Fixture", serverName: "openwork-cloud",
    toolName: "run_artifact_arv_scope", projectedToolName: "openwork-cloud_run_artifact_arv_scope", resourceUri: resource.resourceUri, autoLaunch: true };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = (scope: string) => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={entry} cacheScopeKey={scope} />
  </WorkspaceProvider>);
  try {
    await act(async () => render("viewer-one"));
    expect(container.querySelector(initialState === "result" ? "[data-sandbox-view]" : '[data-testid="desktop-connection-card"]')).not.toBeNull();
    await act(async () => render("viewer-two"));
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(container.querySelector('[data-testid="desktop-connection-card"]')).toBeNull();
    expect(container.textContent).toContain("Loading");
    await act(async () => pending.resolve({ content: [] }));
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("viewer-one");
    window.localStorage.removeItem("viewer-two");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["pending", "ready"])("equivalent launch input survives dashboard rerenders while %s", async (phase) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const released: string[] = [];
  let calls = 0;
  let resolutions = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: `stable-${++resolutions}` } }),
    callMcpAppTool: async () => { calls++; return pending.promise; },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const scope = `stable-input-${phase}`;
  let renderCount = 0;
  const input = () => ++renderCount % 2
    ? { timeZone: "Asia/Tokyo", filters: { limit: 3, sources: ["primary", "secondary"] } }
    : { filters: { sources: ["primary", "secondary"], limit: 3 }, timeZone: "Asia/Tokyo" };
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={{ kind: "mcp", id: "stable-input", title: "Fixture", serverName: resource.serverName,
      toolName: resource.toolName, projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
      autoLaunch: true, launchArguments: input() }} cacheScopeKey={scope}
      fallbackEndpoints={[{ client, workspaceId: "fixture" }]} onAutoLaunchEnabled={() => {}} />
  </WorkspaceProvider>);
  try {
    await act(async () => render());
    if (phase === "ready") await act(async () => pending.resolve({ content: [] }));
    const initialArguments = sandboxView?.inputArguments;
    const initialOrigin = sandboxView?.origin;
    for (let i = 0; i < 10; i++) await act(async () => render());
    expect(calls).toBe(1);
    expect(resolutions).toBe(1);
    expect(released).toEqual([]);
    if (phase === "pending") await act(async () => pending.resolve({ content: [] }));
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(container.textContent).not.toContain("run required");
    if (phase === "ready") {
      expect(sandboxView?.inputArguments).toBe(initialArguments);
      expect(sandboxView?.origin).toBe(initialOrigin);
    }
    await refreshCompactTile(container);
    expect(calls).toBe(2);
    expect(resolutions).toBe(2);
    expect(released).toEqual(["stable-1"]);
  } finally {
    await act(async () => pending.resolve({ content: [] }));
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(scope);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["pending", "ready"])("changed arguments with the same tile ID retire the %s invocation and cannot reuse its last good data", async (phase) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const first = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const second = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const requests: unknown[] = [];
  const released: string[] = [];
  let resolutions = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `changed-${++resolutions}` } }),
    callMcpAppTool: async (_workspace, request) => { requests.push(request.arguments); return requests.length === 1 ? first.promise : second.promise; },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const scope = `changed-input-${phase}`;
  const render = (timeZone: string) => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={{ ...liveGeneratedAppEntry(liveView, liveRevision, timeZone), id: "same-id" }} cacheScopeKey={scope} />
  </WorkspaceProvider>);
  try {
    await act(async () => render("UTC"));
    if (phase === "ready") await act(async () => first.resolve({ content: [{ type: "text", text: "first-input" }] }));
    await act(async () => render("Asia/Tokyo"));
    expect(requests).toEqual([{ timeZone: "UTC" }, { timeZone: "Asia/Tokyo" }]);
    expect(released).toEqual(["changed-1"]);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    await act(async () => first.resolve({ content: [{ type: "text", text: "first-input" }] }));
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    await act(async () => second.resolve({ content: [{ type: "text", text: "second-input" }] }));
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "second-input" }]);
    expect(sandboxView?.origin.readOnly).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(scope);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["requiresApproval", "launchApproved"])("same-ID argument changes never replay a manual tile (%s)", async (policy) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const requests: unknown[] = [];
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "manual-input" } }),
    callMcpAppTool: async (_workspace, request) => { requests.push(request.arguments); return { content: [] }; },
    releaseMcpApp: async () => ({ released: true }),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const scope = `manual-input-${policy}`;
  const render = (query: string) => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={{ kind: "mcp", id: "same-manual-id", title: "Fixture", serverName: resource.serverName,
      toolName: resource.toolName, projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
      autoLaunch: true, requiresApproval: policy === "requiresApproval", launchApproved: policy === "launchApproved", launchArguments: { query } }} cacheScopeKey={scope} />
  </WorkspaceProvider>);
  const run = () => {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Run Fixture"]');
    if (!button) throw new Error("Missing manual Run button");
    button.click();
  };
  try {
    await act(async () => render("first"));
    expect(requests).toEqual([]);
    await act(async () => run());
    expect(requests).toEqual([{ query: "first" }]);
    await act(async () => render("second"));
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    for (let i = 0; i < 5; i++) await act(async () => { render("second"); window.dispatchEvent(new Event("focus")); });
    expect(requests).toEqual([{ query: "first" }]);
    await act(async () => run());
    expect(requests).toEqual([{ query: "first" }, { query: "second" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(scope);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("the freshness label ages on its own without another state change", async () => {
  let now = Date.parse("2026-09-15T20:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const interval = spyOn(window, "setInterval");
  const fixture = continuityFixture();
  const host = await mountContinuityTile(fixture);
  try {
    // Healthy tiles keep the badge inside the options menu, where a person reads it.
    const trigger = host.container.querySelector<HTMLButtonElement>('button[aria-label="App options for Fixture"]');
    if (!trigger) throw new Error("Missing compact app menu trigger");
    await act(async () => { trigger.focus(); trigger.click(); });
    const label = () => document.querySelector('[role="menu"] [data-dashboard-cache-state]')?.textContent ?? "";
    expect(label()).toContain("Updated just now");
    const minuteTimers = interval.mock.calls.filter(([, delay]) => delay === 60_000);
    expect(minuteTimers).toHaveLength(1);
    const tick = minuteTimers[0]?.[0];
    if (typeof tick !== "function") throw new Error("Missing freshness timer");
    // Nothing else changes; only the clock and the label timer advance.
    now += 3 * 60_000;
    await act(async () => { tick(); });
    expect(label()).toContain("Updated 3 minutes ago");
    expect(fixture.calls).toHaveLength(1);
    now += 62 * 60_000;
    await act(async () => { tick(); });
    expect(label()).toContain("Updated 1 hour ago");
    expect(fixture.calls).toHaveLength(1);
  } finally { await host.dispose(); clock.mockRestore(); interval.mockRestore(); }
});

test.each(["success", "failure"])("generated dashboard refresh is bounded across rerenders, timer and focus (%s)", async (outcome) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let now = Date.parse("2026-09-14T12:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const interval = spyOn(window, "setInterval");
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  let calls = 0;
  let resolutions = 0;
  let failing = outcome === "failure";
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `timed-${++resolutions}` } }),
    callMcpAppTool: async () => {
      if (++calls === 2) return pending.promise;
      if (calls > 2 && failing) throw new OpenworkServerError(503, "server_unavailable", "Temporary failure");
      return { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <LiveGeneratedApp view={{ ...liveView }} revision={{ ...liveRevision }} fallbackEndpoints={[{ client, workspaceId: "fixture" }]} />
  </WorkspaceProvider>);
  const focus = () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); };
  try {
    await act(async () => render());
    const initialOrigin = sandboxView?.origin;
    for (let i = 0; i < 10; i++) await act(async () => { render(); focus(); });
    expect(calls).toBe(1);
    expect(sandboxView?.origin).toBe(initialOrigin);
    const timers = interval.mock.calls.filter(([, delay]) => delay === DASHBOARD_AUTO_REFRESH_INTERVAL_MS);
    expect(timers).toHaveLength(1);
    const tick = timers[0]?.[0];
    if (typeof tick !== "function") throw new Error("Missing dashboard timer");
    now += DASHBOARD_AUTO_REFRESH_INTERVAL_MS - 1;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(1);
    now++;
    hidden = true;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(1);
    hidden = false;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(2);
    for (let i = 0; i < 5; i++) await act(async () => { render(); tick(); focus(); });
    expect(calls).toBe(2);
    await act(async () => {
      if (outcome === "success") pending.resolve({ content: [] });
      else pending.reject(new OpenworkServerError(503, "server_unavailable", "Temporary failure"));
    });
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    for (let i = 0; i < 5; i++) await act(async () => focus());
    expect(calls).toBe(2);
    failing = false;
    now += DASHBOARD_AUTO_REFRESH_INTERVAL_MS;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(3);
    expect(resolutions).toBe(3);
    await refreshCompactTile(container);
    expect(calls).toBe(4);
    expect(sandboxView?.origin.readOnly).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(liveGeneratedAppCacheScope(viewerScope));
    clock.mockRestore();
    interval.mockRestore();
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["timer", "focus"])("generated day rollover via %s and caller changes isolate late results", async (trigger) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = nextViewerDayBoundary(zone, Date.parse("2026-09-14T12:00:00Z"));
  let now = boundary - 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timeout = spyOn(globalThis, "setTimeout");
  const first = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const third = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const initialScope = viewerScope;
  const nextScope = ["fixture-host", "another-member", "fixture-org"];
  let calls = 0;
  let resolutions = 0;
  const released: string[] = [];
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `day-${++resolutions}` } }),
    callMcpAppTool: async () => {
      if (++calls === 1) return first.promise;
      if (calls === 3) return third.promise;
      return { content: [{ type: "text", text: "new-day" }] };
    },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <LiveGeneratedApp view={{ ...liveView }} revision={{ ...liveRevision }} />
  </WorkspaceProvider>);
  try {
    await act(async () => render());
    expect(calls).toBe(1);
    now = boundary;
    await act(async () => {
      if (trigger === "focus") window.dispatchEvent(new Event("focus"));
      else {
        const tick = timeout.mock.calls.find(([, delay]) => delay === 1_000)?.[0];
        if (typeof tick !== "function") throw new Error("Missing local midnight timer");
        tick();
      }
    });
    expect(calls).toBe(2);
    expect(released).toEqual(["day-1"]);
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "new-day" }]);
    await act(async () => first.resolve({ content: [{ type: "text", text: "late-old-day" }] }));
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "new-day" }]);
    viewerScope = nextScope;
    await act(async () => render());
    expect(calls).toBe(3);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(window.localStorage.getItem(liveGeneratedAppCacheScope(nextScope))).toBeNull();
    await act(async () => third.resolve({ content: [{ type: "text", text: "another-viewer" }] }));
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "another-viewer" }]);
    for (let i = 0; i < 5; i++) await act(async () => { render(); window.dispatchEvent(new Event("focus")); });
    expect(calls).toBe(3);
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(window.localStorage.getItem(liveGeneratedAppCacheScope(initialScope))).not.toContain("late-old-day");
    expect(window.localStorage.getItem(liveGeneratedAppCacheScope(nextScope))).not.toContain("new-day");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    viewerScope = initialScope;
    window.localStorage.removeItem(liveGeneratedAppCacheScope(initialScope));
    window.localStorage.removeItem(liveGeneratedAppCacheScope(nextScope));
    clock.mockRestore();
    timeout.mockRestore();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("reopening a tile paints caller-scoped cached data while refreshing and retains it on a transient failure", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  let calls = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "cache-lease" } }),
    callMcpAppTool: async () => ++calls === 1 ? { content: [] } : pending.promise,
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "cache-reopen", title: "Fixture", serverName: resource.serverName,
    toolName: resource.toolName, projectedToolName: "fixture_render", resourceUri: resource.resourceUri, autoLaunch: true };
  const container = document.body.appendChild(document.createElement("div"));
  let root = createRoot(container);
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={entry} cacheScopeKey="cache-reopen-scope" />
  </WorkspaceProvider>);
  try {
    await act(async () => render());
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    expect(calls).toBe(2);
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    expect(sandboxView?.origin.readOnly).toBe(true);
    expect((await compactRefreshItem(container)).getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.reject(new OpenworkServerError(503, "server_unavailable", "Try again later")));
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    expect(container.querySelector('[data-dashboard-cache-state="failed"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("cache-reopen-scope");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each([false, true])("guarded refresh delivers changed data through one live document (StrictMode: %j)", async strict => {
  const fixture = continuityFixture();
  const host = await mountContinuityTile(fixture, { strict });
  try {
    const view = host.container.querySelector("[data-sandbox-view]");
    const original = sandboxView;
    const outer = host.container.querySelector<HTMLElement>("[data-dashboard-tile]");
    expect(original?.origin.readOnly).toBe(false);
    await act(async () => original?.onHeightChange?.(480));
    await refreshCompactTile(host.container);
    expect(fixture.resolutions).toEqual(["fixture"]);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]?.request).toEqual({
      launchId: "continuity-1", sessionId: null, serverName: resource.serverName, name: resource.toolName,
      resourceUri: resource.resourceUri, arguments: { query: "saved" }, expectedResourceDigest: "a".repeat(64),
    });
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(sandboxView?.app).toBe(original?.app);
    expect(sandboxView?.origin).toBe(original?.origin);
    expect(sandboxView?.inputArguments).toBe(original?.inputArguments);
    expect(sandboxView?.updateMode).toBe("notify");
    expect(host.container.querySelector("[data-rendered-result]")?.textContent).toContain("result-2");
    expect(sandboxView?.result).toMatchObject({ structuredContent: { version: 2 }, _meta: { fixture: true }, isError: false });
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)?.result.structuredContent).toEqual({ version: 2 });
    expect(outer?.getAttribute("aria-busy")).toBe("false");
    expect(outer?.style.minHeight).toBe("");
    expect(host.container.querySelector("header")).toBeNull();
    expect(fixture.released).toEqual([]);
  } finally { await host.dispose(); }
  expect(fixture.released).toEqual(["continuity-1"]);
});

test.each([true, false])("transient refresh failure retains last-good content, actions and geometry (guarded: %j)", async guarded => {
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ guarded, call: async (_request, index) => index === 1
    ? { content: [{ type: "text", text: "last-good" }] } : pending.promise });
  const host = await mountContinuityTile(fixture);
  try {
    const view = host.container.querySelector("[data-sandbox-view]");
    const original = sandboxView;
    await act(async () => original?.onHeightChange?.(412));
    await refreshCompactTile(host.container);
    const outer = host.container.querySelector<HTMLElement>("[data-dashboard-tile]");
    expect(outer?.getAttribute("aria-busy")).toBe("true");
    expect(outer?.style.minHeight).toBe("");
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(host.container.querySelector("header")).toBeNull();
    expect(fixture.released).toEqual([]);
    await act(async () => pending.reject(new Error("Unknown transport outcome")));
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(sandboxView?.app).toBe(original?.app);
    expect(sandboxView?.origin).toBe(original?.origin);
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(sandboxView?.initialHeight).toBe(412);
    expect(host.container.querySelector("[data-rendered-result]")?.textContent).toContain("last-good");
    expect(host.container.querySelector('[data-dashboard-cache-state="failed"]')?.textContent).toContain("last good data");
    expect(host.container.querySelector("header")).toBeNull();
    expect(outer?.getAttribute("aria-busy")).toBe("false");
    expect(fixture.resolutions).toHaveLength(guarded ? 1 : 2);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.released).toEqual(guarded ? [] : ["continuity-2"]);
    await act(async () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    expect(fixture.calls).toHaveLength(2);
  } finally { await host.dispose(); await act(async () => pending.resolve({ content: [] })); }
});

test("a legacy refresh keeps the old frame during network work and replaces it once on success", async () => {
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ guarded: false, call: async (_request, index) => index === 1
    ? { content: [{ type: "text", text: "old" }] } : pending.promise });
  const host = await mountContinuityTile(fixture);
  try {
    const view = host.container.querySelector("[data-sandbox-view]");
    const original = sandboxView;
    await act(async () => original?.onHeightChange?.(360));
    await refreshCompactTile(host.container);
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(sandboxView?.app).toBe(original?.app);
    expect(sandboxView?.origin).toBe(original?.origin);
    expect(fixture.released).toEqual([]);
    await act(async () => pending.resolve({ content: [{ type: "text", text: "new" }] }));
    const replacement = host.container.querySelector("[data-sandbox-view]");
    expect(replacement).not.toBe(view);
    expect(sandboxView?.app.launchId).toBe("continuity-2");
    expect(sandboxView?.initialHeight).toBe(360);
    expect(fixture.released).toEqual(["continuity-1"]);
    await host.render();
    await host.render();
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(replacement);
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.calls).toHaveLength(2);
  } finally { await host.dispose(); await act(async () => pending.resolve({ content: [] })); }
});

test.each(["mcp_app_resource_changed", "mcp_app_refresh_denied"])("a typed %s retires the old document before one controlled fresh launch", async code => {
  const nextResource = Promise.withResolvers<OpenworkMcpAppResource>();
  let dispatches = 0;
  const fixture = continuityFixture({
    resolve: async index => index === 1 ? continuityResource(index) : nextResource.promise,
    call: async request => {
      if (request.expectedResourceDigest) throw new OpenworkServerError(422, code, "Refresh stopped before dispatch");
      dispatches++;
      return { content: [{ type: "text", text: `dispatch-${dispatches}` }] };
    },
  });
  const host = await mountContinuityTile(fixture);
  try {
    const original = sandboxView;
    const view = host.container.querySelector("[data-sandbox-view]");
    await act(async () => original?.onHeightChange?.(444));
    await refreshCompactTile(host.container);
    expect(dispatches).toBe(1);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.released).toEqual(["continuity-1"]);
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(host.container.querySelector<HTMLElement>("[data-dashboard-tile]")?.style.minHeight).toBe("444px");
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    await act(async () => { original?.onReady?.(); original?.onError?.(); original?.onRequestTeardown?.(); });
    expect(host.container.querySelector("[data-dashboard-loading]")).not.toBeNull();
    await act(async () => nextResource.resolve({ ...continuityResource(2), html: "<p>New document</p>" }));
    expect(dispatches).toBe(2);
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls.every(call => call.request.approved === undefined)).toBe(true);
    expect(host.container.querySelector("[data-sandbox-view]")).not.toBe(view);
    expect(sandboxView?.app.launchId).toBe("continuity-2");
    const current = sandboxView;
    await act(async () => { original?.onReady?.(); original?.onError?.(); original?.onRequestTeardown?.(); });
    expect(sandboxView?.app).toBe(current?.app);
    expect(host.container.querySelector("header")).toBeNull();
    expect(host.container.querySelector("[data-dashboard-loading]")).toBeNull();
  } finally { await act(async () => nextResource.resolve(continuityResource(2))); await host.dispose(); }
});

test("a guarded fallback never escalates a read refresh into an approved write", async () => {
  let dispatches = 0;
  const fixture = continuityFixture({
    resolve: async index => index === 1 ? continuityResource(index) : { ...resource, launchId: `continuity-${index}` },
    call: async (request, index) => {
      if (request.expectedResourceDigest) throw new OpenworkServerError(422, "mcp_app_refresh_denied", "Read-only refresh denied");
      if (index > 1) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required");
      dispatches++;
      return { content: [] };
    },
  });
  const host = await mountContinuityTile(fixture);
  try {
    await refreshCompactTile(host.container);
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.calls.every(call => call.request.approved === undefined)).toBe(true);
    expect(dispatches).toBe(1);
    expect(host.disabledCount()).toBe(1);
    expect(host.container.querySelector('[aria-label="Run Fixture"]')).not.toBeNull();
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + DASHBOARD_AUTO_REFRESH_INTERVAL_MS);
    try { await act(async () => window.dispatchEvent(new Event("focus"))); } finally { clock.mockRestore(); }
    expect(fixture.calls).toHaveLength(3);
    expect(fixture.released).toEqual(["continuity-1", "continuity-2"]);
  } finally { await host.dispose(); }
});

test.each([true, false])("provider-result errors preserve the last-good document and release only failed candidates (guarded: %j)", async guarded => {
  const fixture = continuityFixture({ guarded, call: async (_request, index) => index === 1
    ? { content: [{ type: "text", text: "last-good" }], structuredContent: { version: 1 } }
    : { isError: true, content: [{ type: "text", text: "Provider domain error" }], structuredContent: { failed: true } } });
  const host = await mountContinuityTile(fixture);
  try {
    const original = sandboxView;
    const view = host.container.querySelector("[data-sandbox-view]");
    const cached = readDashboardTileCache("continuity-scope", fixture.entry.id);
    await refreshCompactTile(host.container);
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(sandboxView?.app).toBe(original?.app);
    expect(sandboxView?.origin).toBe(original?.origin);
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(sandboxView?.result).toBe(original?.result);
    expect(host.container.querySelector("[data-rendered-result]")?.textContent).toContain("last-good");
    expect(host.container.textContent).not.toContain("Provider domain error");
    expect(host.container.querySelector('[data-dashboard-cache-state="failed"]')).not.toBeNull();
    expect(host.container.querySelector("header")).toBeNull();
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toEqual(cached);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.resolutions).toHaveLength(guarded ? 1 : 2);
    expect(fixture.released).toEqual(guarded ? [] : ["continuity-2"]);
  } finally { await host.dispose(); }
  expect(fixture.released).toEqual(guarded ? ["continuity-1"] : ["continuity-2", "continuity-1"]);
});

test("a provider-result error without last-good data still shows a failure", async () => {
  const fixture = continuityFixture({ call: async () => ({ isError: true, content: [{ type: "text", text: "Provider domain error" }] }) });
  const host = await mountContinuityTile(fixture);
  try {
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(host.container.querySelector("[data-dashboard-loading]")).toBeNull();
    expect(host.container.textContent).toContain("Provider domain error");
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.released).toEqual(["continuity-1"]);
  } finally { await host.dispose(); }
});

test.each(["stale", "401", "403", "connection", "resource_read_failed", "resource_too_large"])("a guarded %s failure purges old authority without resolving or retrying", async failure => {
  const fixture = continuityFixture({ call: async (_request, index) => {
    if (index === 1) return { content: [{ type: "text", text: "last-good" }] };
    const status = failure === "401" || failure === "403" ? Number(failure) : 422;
    const code = failure === "stale" ? "stale_launch_context" : failure === "connection" ? "connection_required"
      : status === 422 ? failure : "forbidden";
    throw new OpenworkServerError(status, code, "Refresh rejected");
  } });
  const host = await mountContinuityTile(fixture);
  try {
    await refreshCompactTile(host.container);
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(host.container.querySelector("[data-dashboard-loading]")).toBeNull();
    expect(host.container.textContent).toContain("Refresh rejected");
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    expect(fixture.resolutions).toHaveLength(1);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.released).toEqual(["continuity-1"]);
    await host.render();
    await host.render();
    expect(fixture.calls).toHaveLength(2);
  } finally { await host.dispose(); }
});

test("an expired advertised lease takes the normal fresh-launch path, never a guarded expiry retry", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const fixture = continuityFixture();
  const host = await mountContinuityTile(fixture);
  try {
    const expiresAt = sandboxView?.app.refresh?.expiresAt;
    if (expiresAt === undefined) throw new Error("Missing advertised expiry");
    now = expiresAt;
    await refreshCompactTile(host.container);
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls.every(call => call.request.expectedResourceDigest === undefined)).toBe(true);
    expect(fixture.released).toEqual(["continuity-1"]);
  } finally { await host.dispose(); clock.mockRestore(); }
});

test("duplicate focus and visibility signals share one guarded refresh admission", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ call: async (_request, index) => index === 1 ? { content: [] } : pending.promise });
  const scheduled = spyOn(launchScheduler, "scheduleDashboardLaunch");
  const host = await mountContinuityTile(fixture);
  try {
    now += DASHBOARD_AUTO_REFRESH_INTERVAL_MS;
    const focus = () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); };
    await act(async () => { for (let index = 0; index < 10; index++) focus(); });
    for (let index = 0; index < 3; index++) { await host.render(); await act(async () => focus()); }
    expect(fixture.resolutions).toHaveLength(1);
    expect(fixture.calls).toHaveLength(2);
    expect(scheduled).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve({ content: [{ type: "text", text: "refreshed" }] }));
    await act(async () => { for (let index = 0; index < 5; index++) focus(); });
    expect(fixture.calls).toHaveLength(2);
  } finally {
    await host.dispose();
    await act(async () => pending.resolve({ content: [] }));
    scheduled.mockRestore();
    clock.mockRestore();
  }
});

test.each(["requiresApproval", "launchApproved", "organization"])("manual and administrative writes never gain guarded reuse or replay on rerender: %s", async policy => {
  let dispatches = 0;
  const fixture = continuityFixture({
    entry: { requiresApproval: policy !== "launchApproved", launchApproved: policy === "launchApproved", organizationAutoLaunch: policy === "organization" },
    call: async request => {
      if (!request.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required");
      dispatches++;
      return { content: [] };
    },
  });
  const host = await mountContinuityTile(fixture);
  try {
    if (policy !== "organization") {
      expect(fixture.calls).toHaveLength(0);
      await act(async () => host.container.querySelector<HTMLButtonElement>('[aria-label="Run Fixture"]')?.click());
    }
    expect(dispatches).toBe(1);
    const requests = fixture.calls.length;
    for (let index = 0; index < 5; index++) { await host.render(); await act(async () => window.dispatchEvent(new Event("focus"))); }
    expect(fixture.calls).toHaveLength(requests);
    await refreshCompactTile(host.container);
    expect(dispatches).toBe(2);
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.calls.every(call => call.request.expectedResourceDigest === undefined)).toBe(true);
  } finally { await host.dispose(); }
});

test("an organization-approved read omits its approval override when using the advertised guard", async () => {
  const fixture = continuityFixture({ entry: { organizationAutoLaunch: true } });
  const host = await mountContinuityTile(fixture);
  try {
    expect(fixture.calls[0]?.request.approved).toBe(true);
    await refreshCompactTile(host.container);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.resolutions).toHaveLength(1);
    expect(fixture.calls[1]?.request.expectedResourceDigest).toBe("a".repeat(64));
    expect(fixture.calls[1]?.request.approved).toBeUndefined();
  } finally { await host.dispose(); }
});

test.each(["endpoint", "policy", "scope", "unmount"])("pending guarded results and document callbacks cannot outlive %s invalidation", async change => {
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const nextScope = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ call: async (_request, index) => index === 1
    ? { content: [{ type: "text", text: "first-scope" }] } : index === 2 ? pending.promise : nextScope.promise });
  const host = await mountContinuityTile(fixture);
  try {
    const original = sandboxView;
    await refreshCompactTile(host.container);
    expect(fixture.calls).toHaveLength(2);
    if (change === "unmount") await host.dispose();
    else if (change === "endpoint") await host.render({ client: null });
    else if (change === "policy") await host.render({ entry: { ...fixture.entry, requiresApproval: true } });
    else await host.render({ cacheScopeKey: "next-continuity-scope" });
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(fixture.released).toEqual(["continuity-1"]);
    if (change === "endpoint" || change === "policy") expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    await act(async () => {
      original?.onReady?.(); original?.onHeightChange?.(777); original?.onError?.(); original?.onRequestTeardown?.();
      pending.resolve({ content: [{ type: "text", text: "late-old-result" }] });
    });
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(host.container.textContent).not.toContain("late-old-result");
    if (change === "scope") {
      expect(readDashboardTileCache("next-continuity-scope", fixture.entry.id)).toBeNull();
      await act(async () => nextScope.resolve({ content: [{ type: "text", text: "new-scope" }] }));
      expect(host.container.querySelector("[data-rendered-result]")?.textContent).toContain("new-scope");
      expect(fixture.calls).toHaveLength(3);
    } else {
      if (change === "endpoint") await host.render({ client: fixture.client });
      expect(fixture.resolutions).toHaveLength(1);
      expect(fixture.calls).toHaveLength(2);
    }
  } finally {
    await host.dispose();
    await act(async () => { pending.resolve({ content: [] }); nextScope.resolve({ content: [] }); });
  }
});

test.each(["workspace", "resource", "input"])("cached data with a mismatched %s never mounts or gains lease authority", async mismatch => {
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ call: async () => pending.promise });
  writeDashboardTileCache("continuity-scope", fixture.entry.id, {
    argumentsSignature: JSON.stringify(mismatch === "input" ? { query: "other" } : fixture.entry.launchArguments),
    cachedAt: Date.now(), workspaceId: mismatch === "workspace" ? "other-workspace" : "fixture",
    app: { ...continuityResource(1), ...(mismatch === "resource" ? { resourceUri: "ui://fixture/other.html" } : {}) },
    result: { content: [{ type: "text", text: "unrelated-cache" }] },
  });
  const host = await mountContinuityTile(fixture);
  try {
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    expect(host.container.querySelector<HTMLElement>("[data-dashboard-tile]")?.style.minHeight).toBe("320px");
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.request.expectedResourceDigest).toBeUndefined();
    await act(async () => pending.resolve({ content: [{ type: "text", text: "current-data" }] }));
    expect(host.container.querySelector("[data-rendered-result]")?.textContent).toContain("current-data");
    expect(host.container.textContent).not.toContain("unrelated-cache");
  } finally { await host.dispose(); await act(async () => pending.resolve({ content: [] })); }
});

test.each([undefined, 560])("loading reserves geometry until document readiness, then permits shrink (known frame height: %j)", async knownHeight => {
  const recorded: number[] = [];
  const geometry = spyOn(tileGeometry, "useDashboardTileGeometry").mockImplementation(function useFixtureGeometry() {
    const ref = useRef<HTMLDivElement>(null);
    return { ref, initialHeight: knownHeight, reservedHeight: knownHeight === undefined ? undefined : knownHeight + 40,
      recordHeight: (height: number) => { recorded.push(height); } };
  });
  automaticallyReady = false;
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ call: async () => pending.promise });
  const host = await mountContinuityTile(fixture);
  try {
    const outer = host.container.querySelector<HTMLElement>("[data-dashboard-tile]");
    expect(outer?.style.minHeight).toBe(knownHeight === undefined ? "320px" : "600px");
    expect(outer?.getAttribute("aria-busy")).toBe("true");
    expect(host.container.querySelector("[data-dashboard-loading]")).not.toBeNull();
    await act(async () => pending.resolve({ content: [] }));
    expect(sandboxView?.initialHeight).toBe(knownHeight);
    expect(host.container.querySelector("[data-dashboard-loading]")).not.toBeNull();
    const view = host.container.querySelector<HTMLElement>("[data-sandbox-view]");
    const surface = view?.parentElement;
    // The overlay covers startup without hiding the embedded browsing context.
    expect(surface?.style.visibility).toBe("");
    expect(surface?.hasAttribute("inert")).toBe(true);
    expect(surface?.getAttribute("aria-hidden")).toBe("true");
    await act(async () => sandboxView?.onReady?.());
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(surface?.hasAttribute("inert")).toBe(false);
    expect(surface?.hasAttribute("aria-hidden")).toBe(false);
    expect(host.container.querySelector("[data-dashboard-tile]")).toBe(outer);
    expect(outer?.getAttribute("aria-busy")).toBe("false");
    expect(outer?.style.minHeight).toBe("");
    expect(host.container.querySelector("[data-dashboard-loading]")).toBeNull();
    await act(async () => sandboxView?.onHeightChange?.(73));
    expect(recorded).toEqual([73]);
    expect(outer?.style.minHeight).toBe("");
  } finally { await host.dispose(); await act(async () => pending.resolve({ content: [] })); geometry.mockRestore(); automaticallyReady = true; }
});

test("geometry records the actual fallback owner and separates changed input identities", async () => {
  const identities: Array<{ scopeKey: string; entryId: string; workspaceId: string }> = [];
  const heights: Array<{ workspaceId: string; height: number }> = [];
  const geometry = spyOn(tileGeometry, "useDashboardTileGeometry").mockImplementation(function useFixtureGeometry(scopeKey, entryId, workspaceId) {
    const ref = useRef<HTMLDivElement>(null);
    identities.push({ scopeKey, entryId, workspaceId });
    return { ref, initialHeight: 420, reservedHeight: 460, recordHeight: (height: number) => { heights.push({ workspaceId, height }); } };
  });
  const fixture = continuityFixture();
  const primary: OpenworkServerClient = { ...fixture.client, resolveMcpApp: async () => ({ app: null }) };
  const host = await mountContinuityTile(fixture, { client: primary, workspaceId: "primary", fallbackEndpoints: [{ client: fixture.client, workspaceId: "owner" }] });
  try {
    const originalId = identities.at(-1)?.entryId;
    expect(identities[0]?.workspaceId).toBe("primary");
    expect(identities.at(-1)?.workspaceId).toBe("owner");
    expect(sandboxView?.initialHeight).toBe(420);
    await act(async () => sandboxView?.onHeightChange?.(200));
    expect(heights).toEqual([{ workspaceId: "owner", height: 200 }]);
    await refreshCompactTile(host.container);
    expect(fixture.resolutions).toEqual(["owner"]);
    expect(identities.at(-1)?.entryId).toBe(originalId);
    await host.render({ entry: { ...fixture.entry, launchArguments: { query: "different" } } });
    expect(identities.at(-1)?.workspaceId).toBe("owner");
    expect(identities.at(-1)?.entryId).not.toBe(originalId);
    expect(identities.every(identity => identity.scopeKey === "continuity-scope")).toBe(true);
    expect(fixture.resolutions).toEqual(["owner", "owner"]);
  } finally { await host.dispose(); geometry.mockRestore(); }
});

test("a bridge failure before onReady removes the overlay and requires a new document", async () => {
  automaticallyReady = false;
  const fixture = continuityFixture();
  const host = await mountContinuityTile(fixture);
  try {
    const failed = sandboxView;
    const view = host.container.querySelector("[data-sandbox-view]");
    expect(host.container.querySelector("[data-dashboard-loading]")).not.toBeNull();
    await act(async () => failed?.onError?.());
    expect(host.container.querySelector("[data-dashboard-loading]")).toBeNull();
    expect(host.container.querySelector("[data-sandbox-view]")).toBe(view);
    expect(host.container.querySelector("header")).not.toBeNull();
    expect(fixture.released).toEqual(["continuity-1"]);
    expect(readDashboardTileCache("continuity-scope", fixture.entry.id)).toBeNull();
    await act(async () => failed?.onReady?.());
    expect(host.container.querySelector("header")).not.toBeNull();
    expect(fixture.calls).toHaveLength(1);
    automaticallyReady = true;
    await act(async () => host.container.querySelector<HTMLButtonElement>('header [aria-label="Refresh Fixture"]')?.click());
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]?.request.expectedResourceDigest).toBeUndefined();
    expect(host.container.querySelector("[data-sandbox-view]")).not.toBe(view);
    expect(host.container.querySelector("[data-dashboard-loading]")).toBeNull();
    expect(host.container.querySelector("header")).toBeNull();
  } finally { await host.dispose(); automaticallyReady = true; }
});

test("network admission is shared, queued manual launches abort safely, and priority follows the stable tile", async () => {
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const first = continuityFixture({ entry: { id: "slot-one" }, call: async () => pending.promise });
  const second = continuityFixture({ entry: { id: "slot-two" }, call: async () => pending.promise });
  const queued = continuityFixture({ entry: { id: "slot-three", requiresApproval: true } });
  const scheduled = spyOn(launchScheduler, "scheduleDashboardLaunch");
  const firstHost = await mountContinuityTile(first, { cacheScopeKey: "slot-one-scope" });
  const secondHost = await mountContinuityTile(second, { cacheScopeKey: "slot-two-scope" });
  const queuedHost = await mountContinuityTile(queued, { cacheScopeKey: "slot-three-scope" });
  try {
    await act(async () => queuedHost.container.querySelector<HTMLButtonElement>('[aria-label="Run Fixture"]')?.click());
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(queued.resolutions).toHaveLength(0);
    expect(queued.calls).toHaveLength(0);
    expect(scheduled).toHaveBeenCalledTimes(3);
    const options = scheduled.mock.calls[2]?.[1];
    expect(options?.priority?.()).toBe(2);
    const node = firstHost.container.querySelector<HTMLElement>("[data-dashboard-tile]");
    if (!node) throw new Error("Missing stable tile wrapper");
    const bounds = spyOn(node, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 640, 320));
    try { expect(scheduled.mock.calls[0]?.[1].priority?.()).toBe(1); } finally { bounds.mockRestore(); }
    await queuedHost.dispose();
    expect(options?.signal.aborted).toBe(true);
    await act(async () => pending.resolve({ content: [] }));
    expect(queued.resolutions).toHaveLength(0);
    expect(queued.calls).toHaveLength(0);
    expect(first.resolutions).toHaveLength(1);
    expect(second.resolutions).toHaveLength(1);
  } finally {
    await queuedHost.dispose();
    await secondHost.dispose();
    await firstHost.dispose();
    await act(async () => pending.resolve({ content: [] }));
    scheduled.mockRestore();
  }
});

test("changed captured input retires the old document before exposing the new input", async () => {
  const pending = Promise.withResolvers<OpenworkMcpAppToolResult>();
  const fixture = continuityFixture({ call: async (_request, index) => index === 1 ? { content: [] } : pending.promise });
  const host = await mountContinuityTile(fixture);
  try {
    const original = sandboxView;
    await act(async () => original?.onHeightChange?.(600));
    if (!fixture.entry.launchArguments) throw new Error("Missing fixture input");
    fixture.entry.launchArguments.query = "changed";
    await refreshCompactTile(host.container);
    expect(fixture.resolutions).toHaveLength(2);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.calls[1]?.request.arguments).toEqual({ query: "changed" });
    expect(fixture.calls[1]?.request.expectedResourceDigest).toBeUndefined();
    expect(host.container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(sandboxView?.inputArguments).toBe(original?.inputArguments);
    expect(original?.inputArguments).toEqual({ query: "saved" });
    expect(fixture.released).toEqual(["continuity-1"]);
    await act(async () => { original?.onReady?.(); original?.onHeightChange?.(777); original?.onError?.(); });
    expect(host.container.querySelector("[data-dashboard-loading]")).not.toBeNull();
    await act(async () => pending.resolve({ content: [{ type: "text", text: "new-input-result" }] }));
    expect(sandboxView?.inputArguments).toEqual({ query: "changed" });
    expect(sandboxView?.app.launchId).toBe("continuity-2");
    expect(host.container.querySelector("header")).toBeNull();
  } finally { await host.dispose(); await act(async () => pending.resolve({ content: [] })); }
});
