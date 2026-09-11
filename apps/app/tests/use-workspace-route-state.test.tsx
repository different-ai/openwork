/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { RouteSession, RouteSessionListTransport, RouteWorkspace } from "../src/react-app/shell/route-workspaces";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const defaultWorkspaces: RouteWorkspace[] = [
  { id: "ws_1", name: "One", displayNameResolved: "One", workspaceType: "local", path: "/tmp/ws_1" },
  { id: "ws_2", name: "Two", displayNameResolved: "Two", workspaceType: "local", path: "/tmp/ws_2" },
  {
    id: "rem_remote", name: "Remote", displayNameResolved: "Remote", workspaceType: "remote",
    remoteType: "openwork", path: "/tmp/remote", baseUrl: "http://remote.invalid", openworkToken: "remote-token",
  },
];
let workspaces = defaultWorkspaces;
let connection = { baseUrl: "http://localhost:4100", token: "token-1" };
let localStatus = deferred<{ enabled: boolean; chatRouting: boolean }>();
const remoteStatuses = new Map<string, ReturnType<typeof deferred<{ enabled: boolean; chatRouting: boolean }>>>();
let bootReadyCalls = 0;
const markRouteReady = () => { bootReadyCalls += 1; };
const requests: Array<{
  workspaceId: string;
  engine: "v1" | "v2";
  endpoint: ResolvedWorkspaceEndpoint;
  response: ReturnType<typeof deferred<RouteSession[]>>;
}> = [];

const serverModule = await import("../src/app/lib/openwork-server");
const createServerClient = serverModule.createOpenworkServerClient;
mock.module("@/app/lib/openwork-server", () => ({
  ...serverModule,
  createOpenworkServerClient: (options: Parameters<typeof createServerClient>[0]) => ({
    ...createServerClient(options),
    listWorkspaces: async () => ({ items: workspaces, activeId: "ws_1" }),
    activateWorkspace: async () => undefined,
    getEngineV2PreviewStatus: async () => {
      const remoteStatus = remoteStatuses.get(options.baseUrl);
      if (remoteStatus) return remoteStatus.promise;
      if (options.baseUrl === "http://remote.invalid") {
        throw new serverModule.OpenworkServerError(404, "not_found", "Legacy worker");
      }
      return localStatus.promise;
    },
  }),
}));
const routeWorkspaces = await import("../src/react-app/shell/route-workspaces");
const v2Transport = routeWorkspaces.v2RouteSessionList;
mock.module("@/react-app/shell/route-workspaces", () => ({
  ...routeWorkspaces,
  listRouteSessions: (endpoint: ResolvedWorkspaceEndpoint, transport?: RouteSessionListTransport) => {
    const response = deferred<RouteSession[]>();
    requests.push({ workspaceId: endpoint.workspaceId, engine: transport === v2Transport ? "v2" : "v1", endpoint, response });
    return response.promise;
  },
}));
mock.module("@/react-app/shell/openwork-connection", () => ({
  resolveOpenworkConnection: async () => ({
    normalizedBaseUrl: connection.baseUrl, resolvedToken: connection.token, resolvedHostToken: "", hostInfo: null,
  }),
}));
mock.module("@/react-app/kernel/local-provider", () => ({ useLocal: () => ({ prefs: { hasCompletedOnboarding: true } }) }));
mock.module("@/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ status: "signed-out", isSignedIn: false }) }));
mock.module("@/react-app/shell/boot-state", () => ({ useBootState: () => ({ markRouteReady, phase: "ready", routeReady: true }) }));
mock.module("@/app/lib/app-inspector", () => ({
  publishInspectorOpencodeClient: () => () => undefined,
  publishInspectorSlice: () => () => undefined,
  recordInspectorEvent: () => undefined,
}));

const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");
const handle: { current: ReturnType<typeof useWorkspaceRouteState> | null } = { current: null };
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const input = { developerMode: false, onServerSettingsChanged: () => undefined, onHostInfo: () => undefined };

function Probe() {
  handle.current = useWorkspaceRouteState(input);
  return null;
}

function route() {
  if (!handle.current) throw new Error("Route is not mounted");
  return handle.current;
}

async function mount(workspaceId = "ws_1") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(
      <MemoryRouter initialEntries={[`/workspace/${workspaceId}/session`]}>
        <Routes><Route path="/workspace/:workspaceId/session" element={<Probe />} /></Routes>
      </MemoryRouter>,
    );
  });
}

function session(workspaceId: string, id: string): RouteSession {
  return { id, title: id, slug: id, projectID: "project", directory: `/tmp/${workspaceId}`, version: "1", time: { created: 1, updated: 1 } };
}

async function publishRouting(v2: boolean) {
  await act(async () => { localStatus.resolve({ enabled: v2, chatRouting: v2 }); });
}

beforeEach(() => {
  window.localStorage.clear();
  workspaces = defaultWorkspaces;
  requests.length = 0;
  remoteStatuses.clear();
  bootReadyCalls = 0;
  connection = { baseUrl: "http://localhost:4100", token: "token-1" };
  localStatus = deferred();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    for (const request of requests) request.response.resolve([]);
    localStatus.resolve({ enabled: false, chatRouting: false });
    for (const status of remoteStatuses.values()) status.resolve({ enabled: false, chatRouting: false });
  });
  root = null;
  container?.remove();
  container = null;
  handle.current = null;
});

afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

test("routing readiness starts the fifth selected local workspace before slow background lists finish", async () => {
  workspaces = Array.from({ length: 5 }, (_, index): RouteWorkspace => ({
    id: `ws_${index + 1}`, name: `Workspace ${index + 1}`, displayNameResolved: `Workspace ${index + 1}`,
    workspaceType: "local", path: `/tmp/ws_${index + 1}`,
  }));
  await mount("ws_5");
  expect(route().selectedWorkspaceId).toBe("ws_5");
  expect(requests).toHaveLength(0);

  await publishRouting(true);
  // No background response has resolved: the selected workspace must be in the first batch.
  expect(requests.map((request) => request.workspaceId)).toEqual(["ws_5", "ws_1", "ws_2", "ws_3"]);
  const selected = requests.find((request) => request.workspaceId === "ws_5");
  if (!selected) throw new Error("Expected selected workspace inventory load");
  await act(async () => { selected.response.resolve([session("ws_5", "selected")]); });
  expect(route().sessionsByWorkspaceId.ws_5.map((item) => item.id)).toEqual(["selected"]);
  expect(route().retryingWorkspaceIds).not.toContain("ws_5");
  expect(requests).toHaveLength(4);

  await act(async () => {
    for (const request of requests) request.response.resolve([session(request.workspaceId, "background")]);
  });
  expect(requests).toHaveLength(5);
  await act(async () => {
    requests.find((request) => request.workspaceId === "ws_4")?.response.resolve([session("ws_4", "background")]);
  });
});

for (const staleCompletesFirst of [true, false]) {
  test(`refreshes every local inventory after switching to v2; stale v1 completes ${staleCompletesFirst ? "first" : "last"}`, async () => {
    await mount();
    // Routing discovery must not gate workspace bootstrap or remote inventory.
    expect(route().loading).toBe(false);
    expect(bootReadyCalls).toBeGreaterThan(0);
    expect(route().opencodeClient).toBeNull();
    expect(requests.map((request) => request.workspaceId)).toEqual(["remote"]);

    await publishRouting(false);
    const initial = requests.filter((request) => request.workspaceId !== "remote");
    expect(initial.map((request) => request.workspaceId).sort()).toEqual(["ws_1", "ws_2"]);
    expect(initial.every((request) => request.engine === "v1")).toBe(true);
    await act(async () => {
      initial.find((request) => request.workspaceId === "ws_2")?.response.resolve([session("ws_2", "cached-v1")]);
    });
    expect(route().loadedWorkspaceIds.has("ws_2")).toBe(true);
    const stale = initial.filter((request) => request.workspaceId === "ws_1");

    localStatus = deferred();
    await act(async () => { window.dispatchEvent(new Event("openwork-server-settings-changed")); });
    await publishRouting(true);
    const fresh = requests.filter((request) => request.engine === "v2");
    // The delayed list cannot block v2, and the already-loaded, unselected inventory refreshes too.
    expect(fresh.map((request) => request.workspaceId).sort()).toEqual(["ws_1", "ws_2"]);
    expect(requests.filter((request) => request.workspaceId === "remote")).toHaveLength(1);

    const finishStale = async () => {
      await act(async () => {
        for (const request of stale) request.response.resolve([session(request.workspaceId, "obsolete")]);
      });
    };
    if (staleCompletesFirst) {
      await finishStale();
      expect(route().sessionsByWorkspaceId.ws_1).toEqual([]);
      expect(route().sessionsByWorkspaceId.ws_2.map((item) => item.id)).toEqual(["cached-v1"]);
      expect(route().loadedWorkspaceIds.has("ws_1")).toBe(false);
      expect(route().loadedWorkspaceIds.has("ws_2")).toBe(false);
      expect(route().retryingWorkspaceIds).toContain("ws_1");
    }
    await act(async () => {
      for (const request of fresh) request.response.resolve([session(request.workspaceId, "fresh")]);
    });
    if (!staleCompletesFirst) await finishStale();
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["fresh"]);
    expect(route().sessionsByWorkspaceId.ws_2.map((item) => item.id)).toEqual(["fresh"]);
    expect(route().retryingWorkspaceIds).not.toContain("ws_1");
    expect(route().loadedWorkspaceIds.has("ws_2")).toBe(true);
  });
}

test("a rotated endpoint waits for its own routing and rejects the old endpoint's late inventory", async () => {
  await mount();
  await publishRouting(false);
  const stale = requests.filter((request) => request.workspaceId !== "remote");
  connection = { baseUrl: "http://localhost:4200", token: "token-2" };
  localStatus = deferred();
  await act(async () => { await route().refreshRouteState({ supersede: true }); });
  expect(route().opencodeClient).toBeNull();
  expect(requests.filter((request) => request.endpoint.baseUrl === connection.baseUrl)).toEqual([]);
  await act(async () => {
    for (const request of stale) request.response.resolve([session(request.workspaceId, "obsolete")]);
  });
  expect(route().sessionsByWorkspaceId.ws_1).toEqual([]);
  await publishRouting(true);
  const fresh = requests.filter((request) => request.endpoint.baseUrl === connection.baseUrl);
  expect(fresh).toHaveLength(2);
  expect(fresh.every((request) => request.engine === "v2" && request.endpoint.token === "token-2")).toBe(true);
});

test("selecting a legacy remote worker neither blocks nor selects the engine for local inventories", async () => {
  await mount("rem_remote");
  expect(route().loading).toBe(false);
  expect(route().opencodeClient).not.toBeNull();
  expect(requests.map((request) => request.workspaceId)).toEqual(["remote"]);
  await publishRouting(true);
  expect(route().opencodeBaseUrl).toBe("http://remote.invalid/workspace/remote/opencode");
  expect(requests.filter((request) => request.engine === "v2").map((request) => request.workspaceId).sort()).toEqual(["ws_1", "ws_2"]);
});

test("a late routing-status response cannot switch inventories back to the old engine", async () => {
  await mount();
  const staleStatus = localStatus;
  localStatus = deferred();
  await act(async () => { window.dispatchEvent(new Event("openwork-server-settings-changed")); });
  await publishRouting(true);
  await act(async () => { staleStatus.resolve({ enabled: false, chatRouting: false }); });
  expect(route().opencodeBaseUrl.endsWith("/opencode2")).toBe(true);
  expect(requests.filter((request) => request.workspaceId !== "remote").every((request) => request.engine === "v2")).toBe(true);
});

test("returning from remote B to remote A waits for fresh routing while retaining local readiness", async () => {
  const statusA = deferred<{ enabled: boolean; chatRouting: boolean }>();
  const statusB = deferred<{ enabled: boolean; chatRouting: boolean }>();
  statusA.resolve({ enabled: false, chatRouting: false });
  statusB.resolve({ enabled: false, chatRouting: false });
  remoteStatuses.set("http://remote.invalid", statusA);
  remoteStatuses.set("http://remote-b.invalid", statusB);
  await mount("rem_remote");
  await publishRouting(true);
  expect(route().opencodeClient).not.toBeNull();
  expect(route().opencodeBaseUrl).toBe("http://remote.invalid/workspace/remote/opencode");
  await act(async () => {
    route().setWorkspaces((current) => [...current, {
      id: "rem_b", name: "B", displayNameResolved: "B", workspaceType: "remote",
      remoteType: "openwork", path: "/tmp/b", baseUrl: "http://remote-b.invalid", openworkToken: "remote-b-token",
    }]);
  });

  // Keep local revalidation pending: its continuously polled routing must survive navigation.
  localStatus = deferred();
  await act(async () => { route().navigateToWorkspaceSession("rem_b"); });
  expect(route().selectedWorkspaceId).toBe("rem_b");
  expect(route().opencodeClient).not.toBeNull();

  const freshStatusA = deferred<{ enabled: boolean; chatRouting: boolean }>();
  remoteStatuses.set("http://remote.invalid", freshStatusA);
  await act(async () => { route().navigateToWorkspaceSession("rem_remote"); });
  expect(route().selectedWorkspaceId).toBe("rem_remote");
  expect(route().opencodeClient).toBeNull();
  await act(async () => { freshStatusA.resolve({ enabled: true, chatRouting: true }); });
  expect(route().opencodeClient).not.toBeNull();
  expect(route().opencodeBaseUrl).toBe("http://remote.invalid/workspace/remote/opencode2");

  await act(async () => { route().navigateToWorkspaceSession("ws_1"); });
  expect(route().opencodeClient).not.toBeNull();
  expect(route().opencodeBaseUrl.endsWith("/opencode2")).toBe(true);
});

test("editing an unselected remote endpoint refreshes it without accepting the old response", async () => {
  await mount();
  const stale = requests.find((request) => request.workspaceId === "remote");
  if (!stale) throw new Error("Expected remote inventory load");
  await act(async () => {
    route().setWorkspaces((current) => current.map((workspace) => workspace.id === "rem_remote"
      ? { ...workspace, baseUrl: "http://remote-new.invalid", openworkToken: "remote-token-2" }
      : workspace));
  });
  const fresh = requests.find((request) => request.endpoint.baseUrl === "http://remote-new.invalid");
  if (!fresh) throw new Error("Expected fresh remote inventory load");
  await act(async () => { stale.response.resolve([session("remote", "obsolete")]); });
  expect(route().sessionsByWorkspaceId.rem_remote).toEqual([]);
  expect(route().retryingWorkspaceIds).toContain("rem_remote");
  await act(async () => { fresh.response.resolve([session("remote", "fresh")]); });
  expect(route().sessionsByWorkspaceId.rem_remote.map((item) => item.id)).toEqual(["fresh"]);
  expect(route().workspaceConnectionOverrides.rem_remote.status).toBe("connected");
});
