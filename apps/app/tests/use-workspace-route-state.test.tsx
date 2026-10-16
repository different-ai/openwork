/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { dispatchDenSettingsChanged } from "../src/app/lib/den-session-events";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import type { DenAuthStore } from "../src/react-app/domains/cloud/den-auth-provider";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

const defaultWorkspaces: RouteWorkspace[] = [
  { id: "ws_1", name: "One", displayNameResolved: "One", workspaceType: "local", path: "/tmp/ws_1" },
  { id: "ws_2", name: "Two", displayNameResolved: "Two", workspaceType: "local", path: "/tmp/ws_2" },
];
let workspaces = defaultWorkspaces;
let connection = { baseUrl: "http://localhost:4100", token: "token-1" };
let denAuth: Pick<DenAuthStore, "status" | "isSignedIn" | "verifiedIdentity" | "user"> = {
  status: "signed_out", isSignedIn: false, verifiedIdentity: null, user: null,
};
let bootReadyCalls = 0;
const markRouteReady = () => { bootReadyCalls += 1; };
const requests: Array<{
  workspaceId: string;
  endpoint: ResolvedWorkspaceEndpoint;
  response: ReturnType<typeof deferred<RouteSession[]>>;
}> = [];

const hydrationRequests: Array<{
  sessionId: string;
  baseUrl: string;
  response: ReturnType<typeof deferred<RouteSession>>;
}> = [];
function requestHydration(sessionId: string, baseUrl: string) {
  const response = deferred<RouteSession>();
  hydrationRequests.push({ sessionId, baseUrl, response });
  return response.promise;
}
const nativeSessionModule = await import("../src/app/lib/opencode-session-native");
mock.module("@/app/lib/opencode-session-native", () => ({
  ...nativeSessionModule,
  getNativeSession: (endpoint: Parameters<typeof nativeSessionModule.getNativeSession>[0], sessionId: string) =>
    requestHydration(sessionId, endpoint.opencodeBaseUrl),
}));

const serverModule = await import("../src/app/lib/openwork-server");
const createServerClient = serverModule.createOpenworkServerClient;
mock.module("@/app/lib/openwork-server", () => ({
  ...serverModule,
  createOpenworkServerClient: (options: Parameters<typeof createServerClient>[0]) => ({
    ...createServerClient(options),
    listWorkspaces: async () => ({ items: workspaces, activeId: "ws_1" }),
    activateWorkspace: async () => undefined,
  }),
}));
const routeWorkspaces = await import("../src/react-app/shell/route-workspaces");
mock.module("@/react-app/shell/route-workspaces", () => ({
  ...routeWorkspaces,
  listRouteSessions: (endpoint: ResolvedWorkspaceEndpoint) => {
    const response = deferred<RouteSession[]>();
    requests.push({ workspaceId: endpoint.workspaceId, endpoint, response });
    return response.promise;
  },
}));
mock.module("@/react-app/shell/openwork-connection", () => ({
  resolveOpenworkConnection: async () => ({
    normalizedBaseUrl: connection.baseUrl, resolvedToken: connection.token, resolvedHostToken: "", hostInfo: null,
  }),
}));
mock.module("@/react-app/kernel/local-provider", () => ({ useLocal: () => ({ prefs: { hasCompletedOnboarding: true } }) }));
mock.module("@/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => denAuth }));
mock.module("@/react-app/shell/boot-state", () => ({ useBootState: () => ({ markRouteReady, phase: "ready", routeReady: true }) }));
mock.module("@/app/lib/app-inspector", () => ({
  publishInspectorOpencodeClient: () => () => undefined,
  publishInspectorSlice: () => () => undefined,
  recordInspectorEvent: () => undefined,
}));

const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");
const handle: { current: ReturnType<typeof useWorkspaceRouteState> | null } = { current: null };
const router: { navigate: ReturnType<typeof useNavigate> | null; pathname: string; search: string } = { navigate: null, pathname: "", search: "" };
let probeMounts = 0;
let probeUnmounts = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const input = { developerMode: false, preservePendingConversationRoute: false, onServerSettingsChanged: () => undefined, onHostInfo: () => undefined };

function Probe() {
  handle.current = useWorkspaceRouteState(input);
  useEffect(() => {
    probeMounts += 1;
    return () => { probeUnmounts += 1; handle.current = null; };
  }, []);
  return null;
}

function NavigationProbe() {
  router.navigate = useNavigate();
  router.pathname = useLocation().pathname;
  router.search = useLocation().search;
  return null;
}

async function navigate(path: string | number) {
  const navigate = router.navigate;
  if (!navigate) throw new Error("Router is not mounted");
  await act(async () => {
    if (typeof path === "number") await navigate(path);
    else await navigate(path);
  });
}

function route() {
  if (!handle.current) throw new Error("Route is not mounted");
  return handle.current;
}

async function mount(workspaceId = "ws_1", sessionId?: string, initialPath?: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  await act(async () => {
    mountedRoot.render(
      <MemoryRouter initialEntries={[initialPath ?? `/workspace/${workspaceId}/session${sessionId ? `/${sessionId}` : ""}`]}>
        <NavigationProbe />
        <Routes>
          <Route path="/session" element={<Probe />} />
          <Route path="/workspace/:workspaceId/session" element={<Probe />} />
          <Route path="/workspace/:workspaceId/session/:sessionId" element={<Probe />} />
          <Route path="/workspace/:workspaceId/settings/*" element={<div>Settings</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function session(workspaceId: string, id: string): RouteSession {
  return { id, title: id, slug: id, projectID: "project", directory: `/tmp/${workspaceId}`, version: "1", time: { created: 1, updated: 1 } };
}

beforeEach(() => {
  input.preservePendingConversationRoute = false;
  window.localStorage.clear();
  workspaces = defaultWorkspaces;
  requests.length = 0;
  hydrationRequests.length = 0;
  probeMounts = 0;
  probeUnmounts = 0;
  bootReadyCalls = 0;
  connection = { baseUrl: "http://localhost:4100", token: "token-1" };
  denAuth = { status: "signed_out", isSignedIn: false, verifiedIdentity: null, user: null };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    for (const request of requests) request.response.resolve([]);
    for (const request of hydrationRequests) request.response.resolve(session("ws_1", request.sessionId));
  });
  root = null;
  container?.remove();
  container = null;
  handle.current = null;
});

afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

test("workspace initialization preserves an owned pending route and never hydrates its local identity", async () => {
  input.preservePendingConversationRoute = true;
  await mount("ws_1", undefined, "/session?pendingConversation=local-pending");
  expect(route().selectedWorkspaceId).toBe("ws_1");
  expect(router.pathname).toBe("/session");
  expect(router.search).toBe("?pendingConversation=local-pending");
  expect(route().selectedSessionId).toBeNull();
  expect(hydrationRequests).toHaveLength(0);
  await navigate("/workspace/ws_1/session/ses_created");
  expect(new Set(hydrationRequests.map((request) => request.sessionId))).toEqual(new Set(["ses_created"]));
});

test("first-send publication updates the inventory ref before a stale list response lands", async () => {
  await mount("ws_1");
  const inventory = requests.find((request) => request.workspaceId === "ws_1");
  if (!inventory) throw new Error("Expected an in-flight session inventory");
  await act(async () => {
    route().rememberPendingCreatedSession("ws_1", "ses_created");
    const next = { ...route().sessionsByWorkspaceIdRef.current, ws_1: [session("ws_1", "ses_created")] };
    route().sessionsByWorkspaceIdRef.current = next;
    route().setSessionsByWorkspaceId(next);
    inventory.response.resolve([]);
  });
  expect(route().sessionsByWorkspaceId.ws_1.map((session) => session.id)).toEqual(["ses_created"]);
});

const unchangedDenSettings = {
  settings: { baseUrl: "https://den.invalid", authToken: "den-token", activeOrgId: "org_1" },
};

async function returnFromSettings() {
  denAuth = {
    status: "signed_in", isSignedIn: true,
    verifiedIdentity: { principalId: "user_1", organizationId: "org_1" },
    user: { id: "user_1", email: "user@example.invalid", name: "Test User" },
  };
  workspaces = [defaultWorkspaces[0]];
  await mount("ws_1", "selected");
  expect(hydrationRequests).toHaveLength(1);
  await act(async () => { hydrationRequests[0].response.resolve(session("ws_1", "selected")); });
  expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
  expect(requests).toHaveLength(1);

  await navigate("/workspace/ws_1/settings/general");
  expect(handle.current).toBeNull();
  expect(probeUnmounts).toBe(1);
  await act(async () => { dispatchDenSettingsChanged(unchangedDenSettings); });
  expect(requests).toHaveLength(1);
  await navigate(-1);
  expect(probeMounts).toBe(2);
  expect(router.pathname).toBe("/workspace/ws_1/session/selected");
  expect(route().selectedSessionId).toBe("selected");
  expect(route().selectedWorkspaceId).toBe("ws_1");
  expect(route().loading).toBe(false);
  expect(route().opencodeClient).not.toBeNull();
  expect(requests).toHaveLength(2);
  expect(hydrationRequests).toHaveLength(2);
  expect(hydrationRequests[1].sessionId).toBe("selected");
  expect(hydrationRequests[1].baseUrl).toBe(route().opencodeBaseUrl);
  await act(async () => { requests[0].response.resolve([session("ws_1", "obsolete")]); });
  expect(route().sessionsByWorkspaceId.ws_1).toEqual([]);
  expect(route().selectedWorkspaceIsLoading).toBe(true);
  expect(route().routeNotFoundMessage).toBeNull();
  return { inventory: requests[1], hydration: hydrationRequests[1] };
}

{
  test(`Settings return hydrates the selected session before a delayed empty inventory without losing it`, async () => {
    const { inventory, hydration } = await returnFromSettings();
    await act(async () => { hydration.response.resolve(session("ws_1", "selected")); });
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
    expect(route().retryingWorkspaceIds).toContain("ws_1");
    await act(async () => { inventory.response.resolve([]); });
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
    expect(route().selectedSessionId).toBe("selected");
    expect(route().selectedWorkspaceIsLoading).toBe(false);
    expect(route().routeNotFoundMessage).toBeNull();
    expect(route().isSessionReferenceCurrent({ workspaceId: "ws_1", sessionId: "selected" })).toBe(false);
    expect(hydrationRequests).toHaveLength(2);
  });

  test(`Settings return still hydrates the selected session after its inventory fails`, async () => {
    const { inventory, hydration } = await returnFromSettings();
    await act(async () => {
      inventory.response.reject(new serverModule.OpenworkServerError(400, "invalid_response", "Invalid inventory response"));
    });
    expect(route().sessionsByWorkspaceId.ws_1).toEqual([]);
    expect(route().retryingWorkspaceIds).not.toContain("ws_1");
    expect(route().selectedSessionId).toBe("selected");
    expect(route().selectedWorkspaceIsLoading).toBe(true);
    expect(route().routeNotFoundMessage).toBeNull();
    await act(async () => { hydration.response.resolve(session("ws_1", "selected")); });
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
    expect(route().selectedWorkspaceIsLoading).toBe(false);
    expect(route().routeNotFoundMessage).toBeNull();
    expect(route().isSessionReferenceCurrent({ workspaceId: "ws_1", sessionId: "selected" })).toBe(false);
    expect(hydrationRequests).toHaveLength(2);
  });

  for (const refresh of ["server", "Den"]) {
    test(`same-identity ${refresh} settings refresh retains a directly hydrated session through an empty replacement inventory`, async () => {
      const { inventory, hydration } = await returnFromSettings();
      await act(async () => { hydration.response.resolve(session("ws_1", "selected")); });
      const endpointBefore = route().opencodeBaseUrl;
      const tokenBefore = route().selectedWorkspaceServerToken;
      await act(async () => {
        if (refresh === "Den") dispatchDenSettingsChanged(unchangedDenSettings);
        else window.dispatchEvent(new Event("openwork-server-settings-changed"));
      });
      expect(route().opencodeBaseUrl).toBe(endpointBefore);
      expect(route().selectedWorkspaceServerToken).toBe(tokenBefore);
      expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
      const replacement = requests.at(-1);
      if (!replacement) throw new Error("Expected inventory after refresh");
      await act(async () => { inventory.response.resolve([]); });
      if (replacement !== inventory) {
        expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
        await act(async () => { replacement.response.resolve([]); });
      }
      const whileDirectReadIsDelayed = {
        sessionIds: route().sessionsByWorkspaceId.ws_1.map((item) => item.id),
        selectedSessionId: route().selectedSessionId,
        hydrationReads: hydrationRequests.length,
      };
      expect(route().routeNotFoundMessage).toBeNull();
      expect(route().isSessionReferenceCurrent({ workspaceId: "ws_1", sessionId: "selected" })).toBe(false);
      await act(async () => {
        for (const request of hydrationRequests) request.response.resolve(session("ws_1", request.sessionId));
      });
      expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id)).toEqual(["selected"]);
      expect(route().selectedWorkspaceIsLoading).toBe(false);
      expect(whileDirectReadIsDelayed).toEqual({ sessionIds: ["selected"], selectedSessionId: "selected", hydrationReads: 2 });
      // Display retention must not keep a missing session after leaving it.
      await navigate("/workspace/ws_1/session");
      expect(route().selectedSessionId).toBeNull();
      expect(route().sessionsByWorkspaceId.ws_1).toEqual([]);
      expect(route().isSessionReferenceCurrent({ workspaceId: "ws_1", sessionId: "selected" })).toBe(false);
    });
  }
}

{
  test(`cold deep link keeps an indexed session listed after selecting another one when its direct read lands first`, async () => {
    workspaces = [defaultWorkspaces[0]];
    await mount("ws_1", "other");
    const inventory = requests.find((request) => request.workspaceId === "ws_1");
    if (!inventory) throw new Error("Expected an in-flight session inventory");
    expect(hydrationRequests.map((request) => request.sessionId)).toEqual(["other"]);
    // The direct session read settles a beat before the inventory that already contains it.
    await act(async () => {
      hydrationRequests[0].response.resolve(session("ws_1", "other"));
      inventory.response.resolve([session("ws_1", "long"), session("ws_1", "other")]);
    });
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id).sort()).toEqual(["long", "other"]);
    expect(route().isSessionReferenceCurrent({ workspaceId: "ws_1", sessionId: "other" })).toBe(true);
    await navigate("/workspace/ws_1/session/long");
    expect(route().selectedSessionId).toBe("long");
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id).sort()).toEqual(["long", "other"]);
    await navigate("/workspace/ws_1/session/other");
    expect(route().selectedSessionId).toBe("other");
    expect(hydrationRequests).toHaveLength(1);
    expect(route().sessionsByWorkspaceId.ws_1.map((item) => item.id).sort()).toEqual(["long", "other"]);
  });
}

test("starts the fifth selected local workspace before slow background lists finish", async () => {
  workspaces = Array.from({ length: 5 }, (_, index): RouteWorkspace => ({
    id: `ws_${index + 1}`, name: `Workspace ${index + 1}`, displayNameResolved: `Workspace ${index + 1}`,
    workspaceType: "local", path: `/tmp/ws_${index + 1}`,
  }));
  await mount("ws_5");
  expect(route().selectedWorkspaceId).toBe("ws_5");
  // No background response has resolved: the selected workspace is already loading.
  expect(requests.map((request) => request.workspaceId)).toContain("ws_5");
  const selected = requests.find((request) => request.workspaceId === "ws_5");
  if (!selected) throw new Error("Expected selected workspace inventory load");
  await act(async () => { selected.response.resolve([session("ws_5", "selected")]); });
  expect(route().sessionsByWorkspaceId.ws_5.map((item) => item.id)).toEqual(["selected"]);
  expect(route().retryingWorkspaceIds).not.toContain("ws_5");
  await act(async () => {
    for (const request of requests) request.response.resolve([session(request.workspaceId, "background")]);
  });
});

test("offline recovery reloads cleared inventories even when the unselected scope is unchanged", async () => {
  await mount();
  const initial = [...requests];
  expect(initial.map((request) => request.workspaceId).sort()).toEqual(["ws_1", "ws_2"]);
  await act(async () => {
    for (const request of initial) request.response.resolve([session(request.workspaceId, "cached")]);
  });
  for (const workspace of workspaces) {
    expect(route().sessionsByWorkspaceId[workspace.id].map((item) => item.id)).toEqual(["cached"]);
  }
  // Healthy refreshes must not reload already-loaded, unselected inventories.
  await act(async () => { await route().refreshRouteState({ supersede: true }); });
  expect(requests).toHaveLength(2);

  // Web disconnect clears inventory; transient desktop gaps retain it instead.
  const onlineConnection = connection;
  connection = { baseUrl: "", token: "" };
  await act(async () => { await route().refreshRouteState({ supersede: true }); });
  expect(route().sessionsByWorkspaceId).toEqual({});
  expect(requests).toHaveLength(2);
  expect(route().selectedWorkspaceId).toBe("ws_1");

  connection = onlineConnection;
  await act(async () => { await route().refreshRouteState({ supersede: true }); });
  const recovered = requests.slice(initial.length);
  expect(recovered.map((request) => request.workspaceId).sort()).toEqual(["ws_1", "ws_2"]);
  const unselectedBefore = initial.find((request) => request.workspaceId === "ws_2");
  const unselectedAfter = recovered.find((request) => request.workspaceId === "ws_2");
  if (!unselectedBefore || !unselectedAfter) throw new Error("Expected unselected inventory before and after recovery");
  expect(unselectedAfter.endpoint.baseUrl).toBe(unselectedBefore.endpoint.baseUrl);
  expect(unselectedAfter.endpoint.token).toBe(unselectedBefore.endpoint.token);
  expect(unselectedAfter.endpoint.workspaceId).toBe(unselectedBefore.endpoint.workspaceId);
  await act(async () => {
    for (const request of recovered) request.response.resolve([session(request.workspaceId, "recovered")]);
  });
  for (const workspace of workspaces) {
    expect(route().sessionsByWorkspaceId[workspace.id].map((item) => item.id)).toEqual(["recovered"]);
    expect(route().retryingWorkspaceIds).not.toContain(workspace.id);
  }
  expect(requests).toHaveLength(4);
});

test("a rotated endpoint rejects the old endpoint's late inventory", async () => {
  await mount();
  const stale = [...requests];
  connection = { baseUrl: "http://localhost:4200", token: "token-2" };
  await act(async () => { await route().refreshRouteState({ supersede: true }); });
  await act(async () => {
    for (const request of stale) request.response.resolve([session(request.workspaceId, "obsolete")]);
  });
  expect(route().sessionsByWorkspaceId.ws_1).toEqual([]);
  const fresh = requests.filter((request) => request.endpoint.baseUrl === connection.baseUrl);
  expect(fresh).toHaveLength(2);
  expect(fresh.every((request) => request.endpoint.token === "token-2")).toBe(true);
});
