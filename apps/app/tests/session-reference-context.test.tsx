import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { RouteSession, RouteSessionListTransport, RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import { resolveWorkbenchPaneEndpoint } from "../src/react-app/domains/session/chat/pane-runtime";
import type { SessionMetadataCallbacks } from "../src/components/chat/session-reference";
import { denSettingsChangedEvent } from "../src/app/lib/den-session-events";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getDisplaySessionTitle } from "../src/app/lib/session-title";
import {
  createSessionReferenceIndex,
  isSessionReferenceInventoryCurrent,
  parseSessionReference,
  sessionReferenceHref,
  sessionReferenceKey,
  type SessionReference,
  type SessionReferenceInventory,
} from "../src/components/chat/session-reference";
import {
  SessionReferenceProvider,
  useSessionReferencesMaybe,
  type SessionReferences,
} from "../src/components/chat/session-reference-context";

const ownedDom = typeof globalThis.window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
afterAll(async () => {
  if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (ownedDom) await GlobalRegistrator.unregister();
});

const reference = { workspaceId: "workspace-a", sessionId: "ses_alpha", title: "Alpha", archived: false };
function inventory(title = "Alpha", available = true): SessionReferenceInventory[] {
  return [{ workspaceId: reference.workspaceId, available, sessions: [{ id: reference.sessionId, title }] }];
}

describe("session reference parsing and metadata index", () => {
  test("accepts only bare session IDs and complete supported root-relative routes", () => {
    expect(parseSessionReference("ses_alpha")).toEqual({ sessionId: "ses_alpha" });
    expect(parseSessionReference("/session/ses_alpha")).toEqual({ sessionId: "ses_alpha" });
    expect(parseSessionReference("/workspace/workspace-a/session/ses_alpha")).toEqual({ workspaceId: "workspace-a", sessionId: "ses_alpha" });
    expect(parseSessionReference("/workspace/workspace%3Aa/session/ses_alpha")).toEqual({ workspaceId: "workspace:a", sessionId: "ses_alpha" });
    for (const raw of [
      "", "ses_", "session-a", " ses_alpha", "ses_alpha\n", "ses_alpha\u0000", "ses_alpha?x=1",
      "https://example.test/session/ses_alpha", "http://localhost/session/ses_alpha",
      "openwork://session/ses_alpha", "javascript:ses_alpha", "//example.test/session/ses_alpha",
      "session/ses_alpha", "/session", "/session/", "/session/ses_alpha/", "/session/ses_alpha/messages",
      "/workspace/workspace-a/session", "/workspace//session/ses_alpha", "/workspaces/a/session/ses_alpha",
      "/workspace/../session/ses_alpha", "/workspace/%2e%2e/session/ses_alpha", "/workspace/a%2fb/session/ses_alpha",
      "/workspace/a%5cb/session/ses_alpha", "/workspace/%ZZ/session/ses_alpha", "/workspace/%252f/session/ses_alpha",
      "/session/ses_alpha#message", "/session/ses_alpha?workspace=other", "/session/ses_alpha\n",
      "/session/ses_alpha%0a", "/session/ses_alpha%3f", "/session/ses_alpha%2f", "/session/ses_alpha\\other",
    ]) expect(parseSessionReference(raw)).toBeUndefined();
  });

  test("uses pair identity and refuses ambiguous bare and legacy references", () => {
    const index = createSessionReferenceIndex([
      ...inventory(),
      { workspaceId: "workspace-b", available: true, sessions: [{ id: "ses_alpha", title: "Other Alpha" }] },
      { workspaceId: "workspace-c", available: true, sessions: [{ id: "ses_alpha", title: "Third Alpha" }] },
    ]);
    expect(index.resolve("ses_alpha")).toBeUndefined();
    expect(index.resolve("/session/ses_alpha")).toBeUndefined();
    expect(index.resolve(sessionReferenceHref(reference))).toEqual(reference);
    expect(index.resolve("/workspace/workspace-b/session/ses_alpha")?.title).toBe("Other Alpha");
    expect(index.resolve("/workspace/missing/session/ses_alpha")).toBeUndefined();
    expect(sessionReferenceKey({ workspaceId: "workspace:a", sessionId: "ses_alpha" })).not.toBe(
      sessionReferenceKey({ workspaceId: "workspace", sessionId: "a:ses_alpha" }),
    );
  });

  test("ignores unavailable titles and waits for complete inventories before unscoped resolution", () => {
    let inaccessibleTitleReads = 0;
    const index = createSessionReferenceIndex([
      ...inventory(),
      { workspaceId: "workspace-b", available: false, sessions: [{ id: "ses_alpha", get title() { inaccessibleTitleReads++; return "Cached title"; } }] },
    ]);
    expect(index.resolve("ses_alpha")).toBeUndefined();
    expect(index.resolve(sessionReferenceHref(reference))).toEqual(reference);
    expect(index.resolve("/workspace/workspace-b/session/ses_alpha")).toBeUndefined();
    expect(inaccessibleTitleReads).toBe(0);
    expect(createSessionReferenceIndex(inventory("Cached", false)).get(reference)).toBeUndefined();
    expect(createSessionReferenceIndex([]).get(reference)).toBeUndefined();
    expect(createSessionReferenceIndex([{ workspaceId: "workspace-a", available: true, sessions: [] }]).get(reference)).toBeUndefined();
  });

  test("deduplicates one pair without making it ambiguous and skips malformed metadata IDs", () => {
    const index = createSessionReferenceIndex([{ workspaceId: "workspace-a", available: true, sessions: [
      { id: "ses_alpha", title: "Alpha" },
      { id: "ses_alpha", title: "Duplicate" },
      { id: "ses_bad\ud800", title: "Invalid encoding" },
      { id: "ses_bad\n", title: "Invalid whitespace" },
    ] }]);
    expect(index.resolve("ses_alpha")).toEqual(reference);
    expect(index.resolve("ses_bad\n")).toBeUndefined();
  });

  test("normalizes generated titles, preserves archive metadata and observes replacement inventories", () => {
    const index = createSessionReferenceIndex([{ workspaceId: "workspace-a", available: true, sessions: [
      { id: "ses_alpha", title: "New session - 2026-01-01T12:00:00Z", time: { archived: 123 } },
      { id: "ses_untitled", title: null },
    ] }]);
    expect(index.resolve("ses_alpha")).toEqual({ ...reference, title: getDisplaySessionTitle(""), archived: true });
    expect(index.resolve("ses_untitled")?.title).toBe(getDisplaySessionTitle(null));
    expect(createSessionReferenceIndex(inventory(" Renamed ")).get(reference)?.title).toBe("Renamed");
  });

  test("requires an exact successful inventory scope, never a pending or different endpoint identity", () => {
    expect(isSessionReferenceInventoryCurrent("endpoint-a", "endpoint-a")).toBe(true);
    expect(isSessionReferenceInventoryCurrent(null, "endpoint-a")).toBe(false);
    expect(isSessionReferenceInventoryCurrent("endpoint-b", "endpoint-a")).toBe(false);
    expect(isSessionReferenceInventoryCurrent("endpoint-a", undefined)).toBe(false);
    expect(isSessionReferenceInventoryCurrent("", "")).toBe(false);
    for (const changed of ["different-principal", "different-workspace", "different-engine", "different-directory"]) {
      expect(isSessionReferenceInventoryCurrent(changed, "endpoint-a")).toBe(false);
    }
  });

  test("indexes a large inventory once instead of rescanning metadata for every occurrence", () => {
    let titleReads = 0;
    const sessions = Array.from({ length: 10_000 }, (_, index) => ({
      id: `ses_${index}`,
      get title() { titleReads++; return `Task ${index}`; },
    }));
    const index = createSessionReferenceIndex([{ workspaceId: "workspace-a", available: true, sessions }]);
    expect(titleReads).toBe(10_000);
    for (let occurrence = 0; occurrence < 1_000; occurrence++) {
      expect(index.resolve("ses_9999")?.title).toBe("Task 9999");
    }
    expect(titleReads).toBe(10_000);
  });
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Consumer({ pane, capture }: { pane: string; capture?: (value: SessionReferences | undefined) => void }) {
  const references = useSessionReferencesMaybe();
  capture?.(references);
  const resolved = references?.resolve("ses_alpha");
  return <button data-pane={pane} onClick={() => resolved && references?.openReference(resolved)}>{resolved?.title ?? "Unresolved"}</button>;
}

test("the optional hook needs no provider", async () => {
  await act(async () => root.render(<Consumer pane="standalone" />));
  expect(container.textContent).toBe("Unresolved");
});

test("one provider shares a memoized index across both panes and follows rename and deletion", async () => {
  let primary: SessionReferences | undefined;
  let secondary: SessionReferences | undefined;
  const opened: SessionReference[] = [];
  const render = async (inventories: SessionReferenceInventory[]) => act(async () => root.render(
    <SessionReferenceProvider inventories={inventories} onOpenReference={(value) => opened.push(value)}>
      <Consumer pane="primary" capture={(value) => { primary = value; }} />
      <Consumer pane="secondary" capture={(value) => { secondary = value; }} />
    </SessionReferenceProvider>,
  ));
  const loaded = inventory();
  await render(loaded);
  expect(primary).toBe(secondary);
  const resolved = primary?.resolve("ses_alpha");
  const open = primary?.openReference;
  await render(loaded);
  expect(primary?.resolve("ses_alpha")).toBe(resolved);
  await render(inventory("Renamed"));
  expect(container.textContent).toBe("RenamedRenamed");
  const forged = { ...reference, title: "Forged title" };
  open?.(forged);
  expect(opened).toEqual([{ ...reference, title: "Renamed" }]);
  await render(inventory("Cached endpoint title", false));
  open?.(reference);
  expect(opened).toHaveLength(1);
  expect(container.textContent).toBe("UnresolvedUnresolved");
  await render(inventory("New endpoint title"));
  open?.(reference);
  expect(opened.at(-1)?.title).toBe("New endpoint title");
  await render([]);
  open?.(reference);
  expect(opened).toHaveLength(2);
  expect(container.textContent).toBe("UnresolvedUnresolved");
});

test("click-time authorization revalidation blocks stale references without fetching metadata", async () => {
  let current = true;
  let references: SessionReferences | undefined;
  const opened: SessionReference[] = [];
  await act(async () => root.render(
    <SessionReferenceProvider inventories={inventory()} isReferenceCurrent={() => current} onOpenReference={(value) => opened.push(value)}>
      <Consumer pane="primary" capture={(value) => { references = value; }} />
    </SessionReferenceProvider>,
  ));
  current = false;
  references?.openReference(reference);
  expect(opened).toEqual([]);
  expect(references?.resolve("ses_alpha")).toBeUndefined();
  current = true;
  await act(async () => root.render(<Consumer pane="outside" />));
  references?.openReference(reference);
  expect(opened).toEqual([]);
});

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

const primaryWorkspace: RouteWorkspace = {
  id: "workspace-a", name: "Primary", displayNameResolved: "Primary", workspaceType: "local", path: "/tmp/reference-primary",
};
const secondaryWorkspace: RouteWorkspace = {
  id: "rem_secondary", name: "Secondary", displayNameResolved: "Secondary", workspaceType: "remote",
  remoteType: "openwork", path: "/tmp/reference-secondary", baseUrl: "http://secondary.invalid", openworkToken: "synthetic-secondary",
};
let routeWorkspaces: RouteWorkspace[] = [primaryWorkspace, secondaryWorkspace];
let workspaceListError: Error | null = null;
let splitWorkspaceId = secondaryWorkspace.id;
const v2Servers = new Set<string>();
const inventoryReads: Array<{ endpoint: ResolvedWorkspaceEndpoint; engine: "v1" | "v2"; response: ReturnType<typeof deferred<RouteSession[]>> }> = [];
type MetadataSubscription = Partial<SessionMetadataCallbacks> & {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
  released?: boolean;
};
const metadataSubscriptions: MetadataSubscription[] = [];
let unexpectedNetworkReads = 0;
const originalFetch = globalThis.fetch;
const serverModule = await import("../src/app/lib/openwork-server");
const createServerClient = serverModule.createOpenworkServerClient;
mock.module("@/app/lib/openwork-server", () => ({
  ...serverModule,
  createOpenworkServerClient: (options: Parameters<typeof createServerClient>[0]) => ({
    ...createServerClient(options),
    listWorkspaces: async () => {
      if (workspaceListError) throw workspaceListError;
      return { items: routeWorkspaces, activeId: primaryWorkspace.id };
    },
    activateWorkspace: async () => undefined,
    getEngineV2PreviewStatus: async () => ({ enabled: v2Servers.has(options.baseUrl), chatRouting: v2Servers.has(options.baseUrl) }),
  }),
}));
const routeWorkspaceModule = await import("../src/react-app/shell/route-workspaces");
mock.module("@/react-app/shell/route-workspaces", () => ({
  ...routeWorkspaceModule,
  listRouteSessions: (endpoint: ResolvedWorkspaceEndpoint, transport?: RouteSessionListTransport) => {
    const response = deferred<RouteSession[]>();
    inventoryReads.push({ endpoint, engine: transport === routeWorkspaceModule.v2RouteSessionList ? "v2" : "v1", response });
    return response.promise;
  },
}));
mock.module("@/react-app/shell/openwork-connection", () => ({
  resolveOpenworkConnection: async () => ({
    normalizedBaseUrl: "http://primary.invalid", resolvedToken: "synthetic-primary", resolvedHostToken: "", hostInfo: null,
  }),
}));
mock.module("@/react-app/kernel/local-provider", () => ({ useLocal: () => ({ prefs: { hasCompletedOnboarding: true } }) }));
mock.module("@/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ status: "signed-out", isSignedIn: false }) }));
const markRouteReady = () => undefined;
mock.module("@/react-app/shell/boot-state", () => ({ useBootState: () => ({ markRouteReady, phase: "ready", routeReady: true }) }));
mock.module("@/app/lib/app-inspector", () => ({
  publishInspectorOpencodeClient: () => () => undefined,
  publishInspectorSlice: () => () => undefined,
  recordInspectorEvent: () => undefined,
}));
mock.module("@/react-app/domains/session/sync/session-sync", () => ({
  ensureWorkspaceSessionSync: (input: MetadataSubscription) => {
    metadataSubscriptions.push(input);
    return () => { input.released = true; };
  },
  trackWorkspaceSessionsSync: () => () => undefined,
}));
const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");
const { ReactSessionRuntime } = await import("../src/react-app/domains/session/sync/runtime-sync");
const hookHandle: { current: ReturnType<typeof useWorkspaceRouteState> | null } = { current: null };
const hookInput = { developerMode: false, onServerSettingsChanged: () => undefined, onHostInfo: () => undefined };

function RouteMetadataProbe() {
  const state = useWorkspaceRouteState(hookInput);
  hookHandle.current = state;
  const secondary = state.workspaces.find((workspace) => workspace.id === splitWorkspaceId);
  const pane = resolveWorkbenchPaneEndpoint({
    workspaceId: splitWorkspaceId,
    workspaceTitle: "Synthetic side pane",
    workspace: secondary,
    endpoint: state.endpointForSessionWorkspace(secondary),
  });
  const endpoint = pane.status === "ready" ? pane.endpoint : null;
  return <>
    {state.opencodeClient && state.selectedWorkspaceEndpoint ? <ReactSessionRuntime
      workspaceId={state.selectedWorkspaceEndpoint.workspaceId}
      sessionId={null}
      opencodeBaseUrl={state.opencodeBaseUrl}
      openworkToken={state.selectedWorkspaceServerToken}
      onSessionCreated={state.handleRuntimeSessionCreated}
      onSessionUpdated={state.handleRuntimeSessionUpdated}
      onSessionDeleted={state.handleRuntimeSessionDeleted}
    /> : null}
    {endpoint ? <ReactSessionRuntime
      {...state.createWorkspaceSessionMetadataCallbacks({
        workspaceId: splitWorkspaceId, runtimeWorkspaceId: endpoint.workspaceId,
        opencodeBaseUrl: endpoint.opencodeBaseUrl, openworkToken: endpoint.token,
      })}
      workspaceId={endpoint.workspaceId}
      sessionId={null}
      opencodeBaseUrl={endpoint.opencodeBaseUrl}
      openworkToken={endpoint.token}
    /> : null}
  </>;
}

function hook() {
  if (!hookHandle.current) throw new Error("Missing route hook");
  return hookHandle.current;
}
function loadedReference(workspaceId = primaryWorkspace.id, sessionId = "ses_shared") {
  return createSessionReferenceIndex(hook().sessionReferenceInventories).get({ workspaceId, sessionId });
}
function metadataSession(workspaceId: string, id = "ses_shared", title = `${workspaceId} title`): RouteSession {
  return {
    id, title, slug: id, projectID: "synthetic-project", version: "1", time: { created: 1, updated: 1 },
    directory: workspaceId === primaryWorkspace.id ? primaryWorkspace.path ?? "" : secondaryWorkspace.path ?? "",
  };
}
async function mountRouteMetadata(workspaceId = primaryWorkspace.id) {
  await act(async () => root.render(<MemoryRouter initialEntries={[`/workspace/${workspaceId}/session`]}>
    <Routes><Route path="/workspace/:workspaceId/session" element={<RouteMetadataProbe />} /></Routes>
  </MemoryRouter>));
}
async function finishInventoryReads(reads = [...inventoryReads], title?: string) {
  await act(async () => {
    for (const read of reads) read.response.resolve([metadataSession(read.endpoint.workspaceId, "ses_shared", title)]);
  });
}
function subscription(workspaceId: string) {
  const entry = metadataSubscriptions.findLast((item) => item.workspaceId === workspaceId && !item.released);
  if (!entry) throw new Error(`Missing metadata subscription for ${workspaceId}`);
  return entry;
}

function currentMetadataCallbacks(workspaceId: string) {
  const workspace = hook().workspaces.find((item) => item.id === workspaceId);
  const endpoint = hook().endpointForSessionWorkspace(workspace);
  if (!endpoint) throw new Error("Missing current synthetic runtime endpoint");
  // The primary surface can unmount while errored. Exercise the hook's actual
  // current-generation callback factory directly, not an obsolete subscription.
  return hook().createWorkspaceSessionMetadataCallbacks({
    workspaceId, runtimeWorkspaceId: endpoint.workspaceId,
    opencodeBaseUrl: endpoint.opencodeBaseUrl, openworkToken: endpoint.token,
  });
}

beforeEach(() => {
  window.localStorage.clear();
  routeWorkspaces = [primaryWorkspace, secondaryWorkspace];
  workspaceListError = null;
  splitWorkspaceId = secondaryWorkspace.id;
  v2Servers.clear();
  inventoryReads.length = 0;
  metadataSubscriptions.length = 0;
  hookHandle.current = null;
  unexpectedNetworkReads = 0;
  globalThis.fetch = Object.assign(async () => {
    unexpectedNetworkReads++;
    throw new Error("Unexpected network request in synthetic metadata test");
  }, { preconnect: originalFetch.preconnect });
});
afterEach(async () => {
  await act(async () => { for (const read of inventoryReads) read.response.resolve([]); });
  hookHandle.current = null;
  globalThis.fetch = originalFetch;
  expect(unexpectedNetworkReads).toBe(0);
});

describe("real route metadata provenance and runtime subscriptions", () => {
  for (const owner of [
    { workspaceId: primaryWorkspace.id, runtimeWorkspaceId: primaryWorkspace.id },
    { workspaceId: secondaryWorkspace.id, runtimeWorkspaceId: "secondary" },
  ]) {
    test(`first inventory applies unindexed deletion and update events for ${owner.workspaceId}`, async () => {
      await mountRouteMetadata();
      const runtime = subscription(owner.runtimeWorkspaceId);
      await act(async () => {
        runtime.onSessionDeleted?.("ses_deleted");
        runtime.onSessionUpdated?.({ sessionId: "ses_updated", info: { title: "First rename" } });
        runtime.onSessionUpdated?.({ sessionId: "ses_updated", info: { title: "Latest rename" } });
        runtime.onSessionUpdated?.({ sessionId: "ses_deleted_later", info: { title: "Before deletion" } });
        runtime.onSessionDeleted?.("ses_deleted_later");
        runtime.onSessionUpdated?.({ sessionId: "ses_deleted_later", info: { title: "Late update cannot restore" } });
        runtime.onSessionUpdated?.({ sessionId: "ses_never_listed", info: { title: "Incomplete metadata" } });
      });
      expect(loadedReference(owner.workspaceId, "ses_updated")).toBeUndefined();
      await act(async () => {
        for (const read of inventoryReads) read.response.resolve(read.endpoint.workspaceId === owner.runtimeWorkspaceId
          ? ["ses_deleted", "ses_updated", "ses_deleted_later", "ses_untouched"].map((id) => metadataSession(owner.runtimeWorkspaceId, id, "Older snapshot"))
          : [metadataSession(read.endpoint.workspaceId)]);
      });
      expect(loadedReference(owner.workspaceId, "ses_deleted")).toBeUndefined();
      expect(loadedReference(owner.workspaceId, "ses_deleted_later")).toBeUndefined();
      expect(loadedReference(owner.workspaceId, "ses_never_listed")).toBeUndefined();
      expect(loadedReference(owner.workspaceId, "ses_updated")?.title).toBe("Latest rename");
      expect(hook().sessionsByWorkspaceId[owner.workspaceId].map((session) => session.id)).toEqual(["ses_updated", "ses_untouched"]);
    });
  }

  test("normal refresh recovers an errored workspace without clearing its error beforehand", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    await act(async () => { hook().setErrorsByWorkspaceId({ [primaryWorkspace.id]: "Synthetic workspace failure" }); });
    expect(loadedReference()).toBeUndefined();
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    expect(inventoryReads).toHaveLength(3);
    expect(hook().errorsByWorkspaceId[primaryWorkspace.id]).toBe("Synthetic workspace failure");
    await act(async () => { hook().setErrorsByWorkspaceId((current) => ({ ...current })); });
    await finishInventoryReads(inventoryReads.slice(2), "Recovered through refresh");
    expect(hook().errorsByWorkspaceId[primaryWorkspace.id]).toBeNull();
    expect(hook().retryingWorkspaceIds).not.toContain(primaryWorkspace.id);
    expect(loadedReference()?.title).toBe("Recovered through refresh");
    expect(inventoryReads).toHaveLength(3);
  });

  for (const owner of [
    { workspaceId: primaryWorkspace.id, runtimeWorkspaceId: primaryWorkspace.id },
    { workspaceId: secondaryWorkspace.id, runtimeWorkspaceId: "secondary" },
  ]) {
    for (const operation of ["delete", "rename", "archive"]) {
      test(`errored recovery reconciles current-runtime ${operation} before trusting a stale snapshot for ${owner.workspaceId}`, async () => {
        await mountRouteMetadata();
        await finishInventoryReads();
        await act(async () => { hook().setErrorsByWorkspaceId({ [owner.workspaceId]: "Synthetic access error" }); });
        await act(async () => { await hook().refreshRouteState({ supersede: true }); });
        expect(inventoryReads).toHaveLength(3);
        const recovery = inventoryReads[2];
        expect(recovery.endpoint.workspaceId).toBe(owner.runtimeWorkspaceId);
        const before = hook().sessionsByWorkspaceId[owner.workspaceId];
        const runtime = currentMetadataCallbacks(owner.workspaceId);
        await act(async () => {
          if (operation === "delete") runtime.onSessionDeleted?.("ses_shared");
          else runtime.onSessionUpdated?.({ sessionId: "ses_shared", info: operation === "rename"
            ? { title: "Renamed during recovery" }
            : { time: { created: 1, updated: 2, archived: 2 } } });
        });
        // Recovery events must not clear the error, publish metadata or grant
        // activation before this in-flight inventory has succeeded.
        expect(hook().errorsByWorkspaceId[owner.workspaceId]).toBe("Synthetic access error");
        expect(hook().sessionsByWorkspaceId[owner.workspaceId]).toBe(before);
        expect(loadedReference(owner.workspaceId)).toBeUndefined();
        expect(hook().isSessionReferenceCurrent({ workspaceId: owner.workspaceId, sessionId: "ses_shared" })).toBe(false);
        await act(async () => { recovery.response.resolve([
          metadataSession(owner.runtimeWorkspaceId), metadataSession(owner.runtimeWorkspaceId, "ses_untouched"),
        ]); });
        expect(hook().errorsByWorkspaceId[owner.workspaceId]).toBeNull();
        if (operation === "delete") {
          expect(loadedReference(owner.workspaceId)).toBeUndefined();
          expect(hook().sessionsByWorkspaceId[owner.workspaceId].some((session) => session.id === "ses_shared")).toBe(false);
          expect(hook().isSessionReferenceCurrent({ workspaceId: owner.workspaceId, sessionId: "ses_shared" })).toBe(false);
        } else if (operation === "rename") expect(loadedReference(owner.workspaceId)?.title).toBe("Renamed during recovery");
        else expect(loadedReference(owner.workspaceId)?.archived).toBe(true);
        expect(loadedReference(owner.workspaceId, "ses_untouched")).toBeDefined();
        expect(inventoryReads).toHaveLength(3);
      });
    }
  }

  test("errored recovery rejects obsolete generation, wrong workspace, endpoint, token and engine callbacks", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    const obsolete = subscription(primaryWorkspace.id);
    await act(async () => { hook().setErrorsByWorkspaceId({ [primaryWorkspace.id]: "Synthetic access error" }); });
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    const current = hook().endpointForSessionWorkspace(primaryWorkspace);
    if (!current) throw new Error("Missing synthetic recovery endpoint");
    const runtime = {
      workspaceId: primaryWorkspace.id, runtimeWorkspaceId: current.workspaceId,
      opencodeBaseUrl: current.opencodeBaseUrl, openworkToken: current.token,
    };
    const rejected = [obsolete, ...[
      { runtimeWorkspaceId: "secondary" },
      { opencodeBaseUrl: "http://obsolete.invalid/workspace/workspace-a/opencode" },
      { openworkToken: "obsolete-token" },
      { opencodeBaseUrl: current.opencodeBaseUrl.replace(/opencode$/, "opencode2") },
    ].map((change) => hook().createWorkspaceSessionMetadataCallbacks({ ...runtime, ...change }))];
    await act(async () => {
      for (const callback of rejected) {
        callback.onSessionDeleted?.("ses_shared");
        callback.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Wrong runtime", time: { archived: 2 } } });
        callback.onSessionCreated?.(metadataSession(primaryWorkspace.id, "ses_wrong_created"));
      }
    });
    expect(loadedReference()).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(2));
    expect(loadedReference()?.title).toBe("workspace-a title");
    expect(loadedReference()?.archived).toBe(false);
    expect(loadedReference(primaryWorkspace.id, "ses_wrong_created")).toBeUndefined();
    expect(inventoryReads).toHaveLength(3);
  });

  test("failed recovery discards captured events and never publishes or authorizes their metadata", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    await act(async () => { hook().setErrorsByWorkspaceId({ [primaryWorkspace.id]: "Synthetic access error" }); });
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    const runtime = currentMetadataCallbacks(primaryWorkspace.id);
    const before = hook().sessionsByWorkspaceId[primaryWorkspace.id];
    await act(async () => {
      runtime.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Unconfirmed rename", time: { archived: 2 } } });
      runtime.onSessionCreated?.(metadataSession(primaryWorkspace.id, "ses_unconfirmed"));
      inventoryReads[2].response.reject(new serverModule.OpenworkServerError(403, "forbidden", "Synthetic recovery denial"));
    });
    expect(loadedReference()).toBeUndefined();
    expect(hook().sessionsByWorkspaceId[primaryWorkspace.id]).toBe(before);
    expect(hook().isSessionReferenceCurrent({ workspaceId: primaryWorkspace.id, sessionId: "ses_shared" })).toBe(false);
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    await finishInventoryReads(inventoryReads.slice(3), "Fresh authorized snapshot");
    expect(loadedReference()?.title).toBe("Fresh authorized snapshot");
    expect(loadedReference()?.archived).toBe(false);
    expect(loadedReference(primaryWorkspace.id, "ses_unconfirmed")).toBeUndefined();
    expect(inventoryReads).toHaveLength(4);
  });

  test("authorization revocation during recovery discards its snapshot, journal and captured callbacks", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    await act(async () => { hook().setErrorsByWorkspaceId({ [primaryWorkspace.id]: "Synthetic access error" }); });
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    const recovery = inventoryReads[2];
    const revoked = currentMetadataCallbacks(primaryWorkspace.id);
    await act(async () => {
      revoked.onSessionDeleted?.("ses_shared");
      window.dispatchEvent(new Event(denSettingsChangedEvent));
    });
    expect(loadedReference()).toBeUndefined();
    expect(inventoryReads).toHaveLength(5);
    await act(async () => {
      revoked.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Revoked rename", time: { archived: 2 } } });
      recovery.response.resolve([metadataSession(primaryWorkspace.id, "ses_shared", "Obsolete success")]);
    });
    expect(loadedReference()).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(3), "New scope snapshot");
    expect(loadedReference()?.title).toBe("New scope snapshot");
    expect(loadedReference()?.archived).toBe(false);
    expect(inventoryReads).toHaveLength(5);
  });

  test("the split route helper uses its owning local v2 engine for runtime metadata", async () => {
    const side: RouteWorkspace = { ...primaryWorkspace, id: "workspace-b", path: secondaryWorkspace.path };
    routeWorkspaces = [primaryWorkspace, side, secondaryWorkspace];
    splitWorkspaceId = side.id;
    v2Servers.add("http://primary.invalid");
    await mountRouteMetadata();
    await finishInventoryReads();
    expect(inventoryReads.find((read) => read.endpoint.workspaceId === side.id)?.engine).toBe("v2");
    const runtime = subscription(side.id);
    expect(runtime.baseUrl).toBe("http://primary.invalid/workspace/workspace-b/opencode2");
    await act(async () => {
      runtime.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "V2 side rename" } });
      runtime.onSessionCreated?.(metadataSession(side.id, "ses_v2_created", "V2 side creation"));
    });
    expect(loadedReference(side.id)?.title).toBe("V2 side rename");
    expect(loadedReference(side.id, "ses_v2_created")?.title).toBe("V2 side creation");
    expect(loadedReference()?.title).toBe("workspace-a title");
    const native = hook().endpointForWorkspace(side);
    if (!native) throw new Error("Missing native endpoint");
    const wrongEngine = hook().createWorkspaceSessionMetadataCallbacks({
      workspaceId: side.id, runtimeWorkspaceId: native.workspaceId,
      opencodeBaseUrl: native.opencodeBaseUrl, openworkToken: native.token,
    });
    await act(async () => { wrongEngine.onSessionDeleted("ses_shared"); });
    expect(loadedReference(side.id)?.title).toBe("V2 side rename");
    await act(async () => { runtime.onSessionDeleted?.("ses_shared"); });
    expect(loadedReference(side.id)).toBeUndefined();
    expect(loadedReference()?.title).toBe("workspace-a title");
  });

  test("a v2 primary does not lend its engine selection to a remote v1 side pane", async () => {
    v2Servers.add("http://primary.invalid");
    await mountRouteMetadata();
    await finishInventoryReads();
    expect(subscription(primaryWorkspace.id).baseUrl).toBe("http://primary.invalid/workspace/workspace-a/opencode2");
    const runtime = subscription("secondary");
    expect(runtime.baseUrl).toBe("http://secondary.invalid/workspace/secondary/opencode");
    await act(async () => { runtime.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Remote v1 rename" } }); });
    expect(loadedReference(secondaryWorkspace.id)?.title).toBe("Remote v1 rename");
    expect(loadedReference()?.title).toBe("workspace-a title");
  });

  test("denied workspace discovery requires fresh session lists even when endpoint and token recover unchanged", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    expect(inventoryReads).toHaveLength(2);
    expect(loadedReference()?.title).toBe("workspace-a title");
    const oldRuntime = subscription(primaryWorkspace.id);
    const initial = [...inventoryReads];
    workspaceListError = new serverModule.OpenworkServerError(403, "forbidden", "Synthetic workspace denial");
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    expect(loadedReference()).toBeUndefined();
    expect(inventoryReads).toHaveLength(2);
    workspaceListError = null;
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    expect(inventoryReads).toHaveLength(4);
    expect(loadedReference()).toBeUndefined();
    const recovery = inventoryReads.slice(2);
    for (const read of recovery) {
      const before = initial.find((item) => item.endpoint.workspaceId === read.endpoint.workspaceId);
      expect(read.endpoint.baseUrl).toBe(before?.endpoint.baseUrl);
      expect(read.endpoint.token).toBe(before?.endpoint.token);
    }
    await finishInventoryReads(recovery, "Revalidated title");
    await act(async () => { oldRuntime.onSessionCreated?.(metadataSession(primaryWorkspace.id, "ses_obsolete")); });
    expect(loadedReference()?.title).toBe("Revalidated title");
    expect(loadedReference(primaryWorkspace.id, "ses_obsolete")).toBeUndefined();
  });

  test("permission changes invalidate in-flight and successful inventory provenance", async () => {
    await mountRouteMetadata();
    const obsoleteReads = [...inventoryReads];
    await act(async () => { window.dispatchEvent(new Event(denSettingsChangedEvent)); });
    expect(inventoryReads).toHaveLength(4);
    await finishInventoryReads(obsoleteReads, "Obsolete title");
    expect(loadedReference()).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(2), "Authorized title");
    expect(loadedReference()?.title).toBe("Authorized title");
    await act(async () => { window.dispatchEvent(new Event(denSettingsChangedEvent)); });
    expect(inventoryReads).toHaveLength(6);
    expect(loadedReference()).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(4), "Authorized again");
    expect(loadedReference()?.title).toBe("Authorized again");
  });

  test("admits newly created runtime metadata but never arbitrary cached or pending rows", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    await act(async () => {
      hook().handleRuntimeSessionCreated(metadataSession(primaryWorkspace.id, "ses_created", "Created task"));
      hook().rememberPendingCreatedSession(primaryWorkspace.id, "ses_cached");
      hook().setSessionsByWorkspaceId((current) => ({
        ...current, [primaryWorkspace.id]: [...current[primaryWorkspace.id], metadataSession(primaryWorkspace.id, "ses_cached", "Unverified cache")],
      }));
    });
    expect(loadedReference(primaryWorkspace.id, "ses_created")?.title).toBe("Created task");
    expect(loadedReference(primaryWorkspace.id, "ses_cached")).toBeUndefined();
    expect(inventoryReads).toHaveLength(2);
    await act(async () => {
      hook().handleRuntimeSessionCreated(metadataSession("wrong-workspace", "ses_wrong_directory"));
    });
    expect(loadedReference(primaryWorkspace.id, "ses_wrong_directory")).toBeUndefined();
  });

  test("events arriving during a list read are not lost or overwritten by its older response", async () => {
    await mountRouteMetadata();
    await act(async () => { subscription(primaryWorkspace.id).onSessionCreated?.(metadataSession(primaryWorkspace.id, "ses_early", "Early task")); });
    expect(loadedReference(primaryWorkspace.id, "ses_early")).toBeUndefined();
    await finishInventoryReads();
    expect(loadedReference(primaryWorkspace.id, "ses_early")?.title).toBe("Early task");
    let refresh: Promise<void> = Promise.resolve();
    await act(async () => { refresh = hook().reloadWorkspaceSessions(primaryWorkspace.id); });
    await act(async () => {
      subscription(primaryWorkspace.id).onSessionUpdated?.({ sessionId: "ses_early", info: { title: "Latest rename" } });
      subscription(primaryWorkspace.id).onSessionDeleted?.("ses_shared");
    });
    await act(async () => {
      inventoryReads.at(-1)?.response.resolve([
        metadataSession(primaryWorkspace.id), metadataSession(primaryWorkspace.id, "ses_early", "Stale rename"),
      ]);
      await refresh;
    });
    expect(loadedReference(primaryWorkspace.id, "ses_early")?.title).toBe("Latest rename");
    expect(loadedReference()).toBeUndefined();
  });

  test("clearing a workspace error cannot restore cached provenance without a new successful list", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    await act(async () => { hook().setErrorsByWorkspaceId({ [primaryWorkspace.id]: "Synthetic access denial" }); });
    expect(loadedReference()).toBeUndefined();
    await act(async () => { hook().setErrorsByWorkspaceId({}); });
    expect(loadedReference()).toBeUndefined();
    expect(inventoryReads).toHaveLength(2);
    await act(async () => { await hook().refreshRouteState({ supersede: true }); });
    expect(inventoryReads).toHaveLength(3);
    expect(loadedReference()).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(2), "New authorization");
    expect(loadedReference()?.title).toBe("New authorization");
  });

  test("a creation-triggered reload follows a coalesced older list before trusting newly listed metadata", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    let first: Promise<void> = Promise.resolve();
    let creationRefresh: Promise<void> = Promise.resolve();
    await act(async () => {
      first = hook().reloadWorkspaceSessions(primaryWorkspace.id);
      hook().rememberPendingCreatedSession(primaryWorkspace.id, "ses_result");
      hook().setSessionsByWorkspaceId((current) => ({
        ...current, [primaryWorkspace.id]: [...current[primaryWorkspace.id], metadataSession(primaryWorkspace.id, "ses_result", "Creation result")],
      }));
      creationRefresh = hook().reloadWorkspaceSessions(primaryWorkspace.id);
    });
    expect(inventoryReads).toHaveLength(3);
    expect(loadedReference(primaryWorkspace.id, "ses_result")).toBeUndefined();
    await act(async () => {
      inventoryReads[2].response.resolve([metadataSession(primaryWorkspace.id)]);
      await first;
    });
    expect(inventoryReads).toHaveLength(4);
    expect(loadedReference(primaryWorkspace.id, "ses_result")).toBeUndefined();
    await act(async () => {
      inventoryReads[3].response.resolve([metadataSession(primaryWorkspace.id), metadataSession(primaryWorkspace.id, "ses_result", "Fresh listing")]);
      await creationRefresh;
    });
    expect(loadedReference(primaryWorkspace.id, "ses_result")?.title).toBe("Fresh listing");
  });

  test("secondary metadata updates and deletion use the workspace pair, not the selected primary", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    const side = subscription("secondary");
    await act(async () => {
      side.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Secondary renamed" } });
      side.onSessionCreated?.(metadataSession("secondary", "ses_side_created", "Side task"));
    });
    expect(loadedReference(secondaryWorkspace.id)?.title).toBe("Secondary renamed");
    expect(loadedReference()?.title).toBe("workspace-a title");
    expect(loadedReference(secondaryWorkspace.id, "ses_side_created")?.title).toBe("Side task");
    await act(async () => { side.onSessionDeleted?.("ses_shared"); });
    expect(loadedReference(secondaryWorkspace.id)).toBeUndefined();
    expect(loadedReference()?.title).toBe("workspace-a title");
    expect(inventoryReads).toHaveLength(2);
  });

  test("removing and re-adding a workspace cannot revive its previous metadata subscription", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    const obsolete = subscription("secondary");
    await act(async () => { hook().setWorkspaces([primaryWorkspace]); });
    expect(loadedReference(secondaryWorkspace.id)).toBeUndefined();
    expect(obsolete.released).toBe(true);
    await act(async () => { hook().setWorkspaces([primaryWorkspace, secondaryWorkspace]); });
    expect(loadedReference(secondaryWorkspace.id)).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(2), "Re-added workspace");
    await act(async () => { obsolete.onSessionDeleted?.("ses_shared"); });
    expect(loadedReference(secondaryWorkspace.id)?.title).toBe("Re-added workspace");
  });

  test("secondary endpoint rotation rejects old subscription events, including after returning to that endpoint", async () => {
    await mountRouteMetadata();
    await finishInventoryReads();
    const obsolete = subscription("secondary");
    const rotate = async (next: RouteWorkspace) => act(async () => {
      routeWorkspaces = [primaryWorkspace, next];
      hook().setWorkspaces(routeWorkspaces);
    });
    await rotate({ ...secondaryWorkspace, baseUrl: "http://secondary-new.invalid", openworkToken: "synthetic-new" });
    expect(loadedReference(secondaryWorkspace.id)).toBeUndefined();
    await finishInventoryReads(inventoryReads.slice(2), "New endpoint");
    expect(obsolete.released).toBe(true);
    await act(async () => {
      obsolete.onSessionCreated?.(metadataSession("secondary", "ses_obsolete"));
      obsolete.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Wrong endpoint" } });
      obsolete.onSessionDeleted?.("ses_shared");
    });
    expect(loadedReference(secondaryWorkspace.id)?.title).toBe("New endpoint");
    expect(loadedReference(secondaryWorkspace.id, "ses_obsolete")).toBeUndefined();
    const current = subscription("secondary");
    await act(async () => { current.onSessionUpdated?.({ sessionId: "ses_shared", info: { title: "Fresh event" } }); });
    expect(loadedReference(secondaryWorkspace.id)?.title).toBe("Fresh event");
    await rotate(secondaryWorkspace);
    await finishInventoryReads(inventoryReads.slice(3), "Returned endpoint");
    await act(async () => { obsolete.onSessionDeleted?.("ses_shared"); });
    expect(loadedReference(secondaryWorkspace.id)?.title).toBe("Returned endpoint");
    expect(loadedReference()?.title).toBe("workspace-a title");
  });
});
