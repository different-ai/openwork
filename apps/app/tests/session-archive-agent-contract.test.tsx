/** @jsxImportSource react */
import { afterAll, afterEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { ArchiveSessionOptions, ArchiveSessionOutcome, StopSessionOutcome } from "../src/react-app/domains/session/sidebar/use-session-archive";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import type { OpenworkControlAPI, OpenworkControlAction } from "../src/react-app/shell/control/control-provider";

// Model catalog actions share this registry but are not exercised by archive.
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useCheckDesktopRestriction: () => () => false }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ isSignedIn: false }) }));

// The archive hook talks to a real (fake) engine over HTTP; happy-dom's fetch
// polyfill cannot parse Bun.serve responses, so keep the runtime's fetch.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeRequest = globalThis.Request;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
Object.defineProperty(window, "fetch", { configurable: true, value: nativeFetch });
Object.defineProperty(globalThis, "Request", { configurable: true, value: NativeRequest });
Object.defineProperty(globalThis, "AbortController", { configurable: true, value: NativeAbortController });
Object.defineProperty(globalThis, "AbortSignal", { configurable: true, value: NativeAbortSignal });
// Base UI picks its layout-effect shim at module load, so the app must be
// imported after the DOM exists or the dialog portal never mounts.
const [
  { createOpenworkServerClient },
  { toast },
  { isWorkingStatus, listControlSessions },
  { useSessionArchive },
  { OpenworkControlProvider, useControlAction },
] = await Promise.all([
  import("../src/app/lib/openwork-server"),
  import("../src/components/ui/sonner"),
  import("../src/react-app/domains/session/control/list-control-sessions"),
  import("../src/react-app/domains/session/sidebar/use-session-archive"),
  import("../src/react-app/shell/control/control-provider"),
]);
const { createClient } = await import("../src/app/lib/opencode");
const { sessionWorkHeld } = await import("../src/app/lib/opencode-interruption");
const { useSessionControlActions } = await import("../src/react-app/domains/session/control/session-control-actions");
const { useSessionManagementStore } = await import("../src/react-app/domains/session/sidebar/session-management-store");
const { useWorkbenchStore } = await import("../src/react-app/domains/session/chat/workbench-store");
const { useNotificationStore } = await import("../src/react-app/kernel/notification-store");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const sessionId of [...useSessionManagementStore.getState().pinnedIds]) {
    useSessionManagementStore.getState().togglePin(sessionId);
  }
  useNotificationStore.getState().clearAll();
  useWorkbenchStore.getState().setSplit(null);
  useWorkbenchStore.getState().focusPane("primary");
  jest.useRealTimers();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function settle(ms = 20) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await settle(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("session.list_sessions exposes live activity", () => {
  test("entries carry status and working from the same source as the sidebar", () => {
    const listed = listControlSessions({}, {
      workspaces: [{ id: "ws", name: "Main" }],
      sessionsByWorkspaceId: { ws: [
        { id: "busy", title: "Busy", time: { updated: 3 } },
        { id: "asks", title: "Asks", time: { updated: 2 } },
        { id: "done", title: "Done", time: { updated: 1 } },
        { id: "failed", title: "Failed", time: { updated: 0 } },
      ] },
      pinnedIds: [],
      statusFor: (_workspaceId, sessionId) => (
        sessionId === "busy" ? "responding" : sessionId === "asks" ? "waiting" : sessionId === "failed" ? "error" : "idle"
      ),
    });
    expect(listed.map(({ sessionId, status, working }) => ({ sessionId, status, working }))).toEqual([
      { sessionId: "busy", status: "responding", working: true },
      { sessionId: "asks", status: "waiting", working: true },
      { sessionId: "done", status: "idle", working: false },
      { sessionId: "failed", status: "error", working: false },
    ]);
  });

  test("entries carry the session's bound model and reasoning effort from the engine record", () => {
    const listed = listControlSessions({}, {
      workspaces: [{ id: "ws", name: "Main" }],
      sessionsByWorkspaceId: { ws: [
        // The engine writes {id, providerID, variant}; agents read {providerId, modelId, variant}.
        { id: "high", title: "High", time: { updated: 4 }, model: { id: "claude-fable-5-1", providerID: "lpr_test", variant: "high" } },
        { id: "default", title: "Default", time: { updated: 3 }, model: { id: "gpt-6-astra", providerID: "openai", variant: "default" } },
        { id: "unbound", title: "Unbound", time: { updated: 2 } },
        { id: "partial", title: "Partial", time: { updated: 1 }, model: { providerID: "openai" } },
      ] },
      pinnedIds: [],
      statusFor: () => "idle",
    });
    expect(listed.map(({ sessionId, model }) => ({ sessionId, model }))).toEqual([
      { sessionId: "high", model: { providerId: "lpr_test", modelId: "claude-fable-5-1", variant: "high" } },
      { sessionId: "default", model: { providerId: "openai", modelId: "gpt-6-astra", variant: null } },
      { sessionId: "unbound", model: null },
      { sessionId: "partial", model: null },
    ]);
  });

  test("only finished or failed turns are safe to archive without Stop", () => {
    expect(["thinking", "responding", "waiting", "compacting"].map(isWorkingStatus)).toEqual([true, true, true, true]);
    expect(["idle", "error"].map(isWorkingStatus)).toEqual([false, false]);
  });
});

describe("control bridge contract: channel and structured codes", () => {
  async function mountAction(action: OpenworkControlAction): Promise<OpenworkControlAPI> {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    function Register() {
      useControlAction(action);
      return null;
    }
    await act(async () => root.render(
      <MemoryRouter><OpenworkControlProvider><Register /></OpenworkControlProvider></MemoryRouter>,
    ));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    const api = window.__openworkControl;
    if (!api) throw new Error("control API was not published");
    return api;
  }

  test("actions learn whether an agent bridge or the window issued the command", async () => {
    const seen: boolean[] = [];
    const api = await mountAction({
      id: "test.channel",
      label: "Channel",
      sideEffect: "mutation",
      execute: (_args, helpers) => { seen.push(helpers.bridged); return { ok: true }; },
    });
    await act(async () => {
      expect(await api.command({ id: "test.channel", origin: { sessionId: "ses_requester" } })).toMatchObject({ ok: true });
      expect(await api.execute("test.channel")).toMatchObject({ ok: true });
    });
    expect(seen).toEqual([true, false]);
  });

  test("an action's structured code and hint reach the bridge unchanged", async () => {
    const api = await mountAction({
      id: "test.coded",
      label: "Coded",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "target_working", error: "Busy elsewhere.", hint: "Stop it first." }),
    });
    await act(async () => {
      expect(await api.command({ id: "test.coded", origin: { sessionId: "ses_requester" } })).toMatchObject({
        ok: false,
        code: "target_working",
        error: "Busy elsewhere.",
        hint: "Stop it first.",
      });
      expect(await api.execute("test.coded")).toMatchObject({ ok: false, code: "target_working", hint: "Stop it first." });
    });
  });

  test("unknown codes fall back to failed so the schema stays closed", async () => {
    const api = await mountAction({
      id: "test.odd",
      label: "Odd",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "made_up", error: "Nope." }),
    });
    await act(async () => {
      expect(await api.command({ id: "test.odd" })).toMatchObject({ ok: false, code: "failed", error: "Nope." });
    });
  });
});

describe("archiving a working session: the warning goes back through the request's channel", () => {
  const directory = "/tmp/archive-contract";
  type Engine = { baseUrl: string; busy: Set<string>; children: Record<string, string[]>; requests: string[]; respond: (request: Request) => Response };

  function startEngine(): Engine {
    const engine: Engine = {
      baseUrl: "", busy: new Set(), children: {}, requests: [],
      respond(request) {
        const url = new URL(request.url);
        engine.requests.push(url.pathname);
        if (url.pathname === "/path") return NativeResponse.json({ directory });
        if (url.pathname === "/session/status") {
          return NativeResponse.json(Object.fromEntries([...engine.busy].map((id) => [id, { type: "busy" }])));
        }
        if (url.pathname === "/permission" || url.pathname === "/question") return NativeResponse.json([]);
        const session = /^\/session\/([^/]+)(\/(children|message|abort))?$/.exec(url.pathname);
        if (session) {
          const [, id, , sub] = session;
          if (sub === "abort") {
            engine.busy.delete(id);
            return NativeResponse.json(true);
          }
          if (sub === "children") {
            return NativeResponse.json((engine.children[id] ?? []).map((child) => ({ id: child, parentID: id, directory, title: child, time: { created: 1, updated: 1 } })));
          }
          if (sub === "message") return NativeResponse.json([]);
          return NativeResponse.json({ id, directory, title: id, time: { created: 1, updated: 1 } });
        }
        return NativeResponse.json({ message: "not found" }, { status: 404 });
      },
    };
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: engine.respond });
    engine.baseUrl = `http://127.0.0.1:${server.port}`;
    cleanups.push(() => server.stop(true));
    return engine;
  }

  function session(id: string, title: string, updated: number): RouteSession {
    return { id, slug: id, projectID: "prj", directory, title, version: "1", time: { created: 1, updated } };
  }

  async function mountArchive(engine: Engine, sessions: RouteSession[], hooks: {
    reloadWorkspaceSessions?: () => Promise<unknown>;
    onArchivedChange?: (workspaceId: string, sessionId: string, archived: boolean) => void;
    selectedSessionId?: string | null;
    routeWorkspaceId?: string;
  } = {}) {
    const workspace: RouteWorkspace = {
      id: "ws", name: "Client A / Production", displayNameResolved: "Client A / Production", path: directory, preset: "starter", workspaceType: "local",
    };
    const endpoint: ResolvedWorkspaceEndpoint = {
      baseUrl: engine.baseUrl,
      token: "",
      workspaceId: "ws",
      isRemote: false,
      client: createOpenworkServerClient({ baseUrl: engine.baseUrl }),
      mountedBaseUrl: engine.baseUrl,
      opencodeBaseUrl: engine.baseUrl,
    };
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let archiveSession: ((sessionId: string, archived: boolean, options?: ArchiveSessionOptions) => Promise<ArchiveSessionOutcome>) | null = null;
    let stopSession: ((sessionId: string, options?: ArchiveSessionOptions) => Promise<StopSessionOutcome>) | null = null;
    function Harness() {
      const archive = useSessionArchive({
        workspaces: [workspace],
        sessionsByWorkspaceId: { ws: sessions },
        endpointForWorkspace: () => endpoint,
        selectedWorkspaceId: "ws",
        routeWorkspaceId: hooks.routeWorkspaceId ?? "ws",
        selectedSessionId: hooks.selectedSessionId ?? null,
        draftScope: null,
        navigateToWorkspaceSession: () => undefined,
        reloadWorkspaceSessions: hooks.reloadWorkspaceSessions ?? (async () => undefined),
        onArchivedChange: hooks.onArchivedChange ?? (() => undefined),
      });
      useSessionControlActions({
        workspaces: [workspace], sessionsByWorkspaceId: { ws: sessions }, selectedWorkspaceId: "ws",
        selectedWorkspaceRoot: directory, selectedSessionId: null, canCreateTask: false,
        openworkClient: endpoint.client, opencodeClient: createClient(engine.baseUrl),
        endpointForWorkspace: () => endpoint, navigateToSession: () => {}, navigateToSessionRoot: () => {},
        createTaskInWorkspace: () => null, openModelPicker: () => {}, refreshRouteState: () => {},
        archiveSession: archive.archiveSession,
        stopSession: archive.stopSession,
      });
      useEffect(() => { archiveSession = archive.archiveSession; stopSession = archive.stopSession; });
      return archive.archiveDialog;
    }
    await act(async () => root.render(<MemoryRouter><OpenworkControlProvider><Harness /></OpenworkControlProvider></MemoryRouter>));
    const unmount = async () => { await act(async () => root.unmount()); host.remove(); };
    cleanups.push(unmount);
    if (!archiveSession || !stopSession) throw new Error("archive hook did not mount");
    return Object.assign(archiveSession, { stop: stopSession, unmount });
  }

  function stubFetch(engine: Engine, intercept: (request: Request, requests: Request[]) => Response | Promise<Response> | undefined = () => undefined) {
    const requests: Request[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(intercept(request, requests) ?? engine.respond(request));
    });
    const undo = spyOn(toast, "undo").mockImplementation(() => "");
    cleanups.push(() => { fetch.mockRestore(); undo.mockRestore(); });
    return requests;
  }

  async function flush() {
    await act(async () => { for (let index = 0; index < 200; index += 1) await Promise.resolve(); });
  }

  async function advance(ms: number) {
    await act(async () => { jest.advanceTimersByTime(ms); });
    await flush();
  }

  const errors = spyOn(toast, "error").mockImplementation(() => "");
  cleanups.push(() => { errors.mockClear(); });
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const dialogText = () => dialog()?.textContent ?? "";

  test("an agent archiving another working session is refused through its own channel: no dialog, nothing stopped", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target");
    const archive = await mountArchive(engine, [session("ses_target", "Payroll import", 2), session("ses_requester", "Ops audit", 3)]);
    let outcome: ArchiveSessionOutcome | null = null;
    void archive("ses_target", true, { requester: { sessionId: "ses_requester" }, refuseWorking: true }).then((value) => { outcome = value; });
    await until(() => outcome !== null, "agent archive to resolve");
    expect(outcome).toEqual({ kind: "target_working", sessionId: "ses_target", title: "Payroll import" });
    expect(dialog()).toBeNull();
    expect(engine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  test("a session archiving itself, or its parent, mid-turn is refused without probing activity", async () => {
    const engine = startEngine();
    engine.busy.add("ses_parent").add("ses_child");
    engine.children.ses_parent = ["ses_child"];
    const archive = await mountArchive(engine, [session("ses_parent", "Parent work", 1)]);
    for (const requester of ["ses_parent", "ses_child"]) {
      let outcome: ArchiveSessionOutcome | null = null;
      void archive("ses_parent", true, { requester: { sessionId: requester }, refuseWorking: true }).then((value) => { outcome = value; });
      await until(() => outcome !== null, `self-archive from ${requester} to resolve`);
      expect(outcome).toEqual({ kind: "self_archive_while_working", sessionId: "ses_parent", title: "Parent work" });
      expect(dialog()).toBeNull();
    }
    expect(engine.requests.filter((path) => path === "/session/status")).toEqual([]);
    expect(engine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
  });

  test.each(["tree", "messages", "recheck", "status", "tree_recheck", "patch"])("bounds a non-cooperating %s, releases holds, and never archives from late preflight", async (stage) => {
    const engine = startEngine();
    const late = Promise.withResolvers<Response>();
    const changes: boolean[] = [];
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)], {
      onArchivedChange: (_workspaceId, _sessionId, archived) => { changes.push(archived); },
    });
    let blocked: Request | undefined;
    const requests = stubFetch(engine, (request, seen) => {
      if (blocked) return undefined;
      const path = new URL(request.url).pathname;
      const messageReads = seen.filter(item => new URL(item.url).pathname.endsWith("/message")).length;
      const matchingReads = seen.filter(item => new URL(item.url).pathname === path && item.method === "GET").length;
      if ((stage === "tree" && path === "/session/ses_target" && request.method === "GET")
        || (stage === "messages" && path.endsWith("/message"))
        || (stage === "recheck" && path.endsWith("/message") && messageReads === 2)
        || (stage === "status" && path === "/session/status" && matchingReads === 2)
        || (stage === "tree_recheck" && path === "/session/ses_target" && matchingReads === 2)
        || (stage === "patch" && request.method === "PATCH")) {
        blocked = request;
        return late.promise;
      }
    });
    jest.useFakeTimers();
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true }).then(value => { outcome = value; });
    await flush();
    expect(blocked).toBeDefined();
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(stage !== "tree" && stage !== "messages");
    await advance(3_499);
    expect(outcome).toBeUndefined();
    await advance(1);
    expect(outcome).toMatchObject({ kind: stage === "patch" ? "archive_outcome_unknown" : "verification_failed", message: expect.stringContaining("timed out") });
    expect(blocked?.signal.aborted).toBe(true);
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(false);
    if (!blocked) throw new Error("Missing stalled request");
    late.resolve(engine.respond(blocked));
    await flush();
    expect(requests.filter(request => request.method === "PATCH")).toHaveLength(stage === "patch" ? 1 : 0);
    expect(changes).toEqual([]);
    engine.busy.add("ses_target");
    let retry: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true }).then(value => { retry = value; });
    await flush();
    expect(retry?.kind).toBe("target_working");
  });

  test("bounds a stalled preflight response body without a late PATCH", async () => {
    const engine = startEngine();
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)]);
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const requests = stubFetch(engine, request => {
      if (new URL(request.url).pathname.endsWith("/message")) return new NativeResponse(new ReadableStream<Uint8Array>({
        start(controller) { body = controller; },
      }), { headers: { "Content-Type": "application/json" } });
    });
    jest.useFakeTimers();
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true }).then(value => { outcome = value; });
    await flush();
    expect(body).toBeDefined();
    await advance(3_500);
    expect(outcome?.kind).toBe("verification_failed");
    body?.enqueue(new TextEncoder().encode("[]"));
    body?.close();
    await flush();
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(false);
  });

  test("the human path remains bounded at its existing 15-second budget", async () => {
    const engine = startEngine();
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)]);
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const requests = stubFetch(engine, request => new URL(request.url).pathname.endsWith("/message")
      ? new NativeResponse(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), {
        headers: { "Content-Type": "application/json" },
      }) : undefined);
    jest.useFakeTimers();
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true).then(value => { outcome = value; });
    await flush();
    await advance(14_999);
    expect(outcome).toBeUndefined();
    await advance(1);
    expect(outcome?.kind).toBe("verification_failed");
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
    body?.enqueue(new TextEncoder().encode("[]"));
    body?.close();
    await flush();
  });

  test.each(["cancel", "unmount"])("%s settles a stalled archive and prevents a late PATCH", async (action) => {
    const engine = startEngine();
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)]);
    const late = Promise.withResolvers<Response>();
    const requests = stubFetch(engine, request => new URL(request.url).pathname.endsWith("/message") ? late.promise : undefined);
    const controller = new AbortController();
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true, signal: controller.signal }).then(value => { outcome = value; });
    await flush();
    if (action === "cancel") controller.abort(new Error("Caller cancelled verification"));
    else await archive.unmount();
    await flush();
    expect(outcome?.kind).toBe("verification_failed");
    expect(requests.find(request => new URL(request.url).pathname.endsWith("/message"))?.signal.aborted).toBe(true);
    late.resolve(NativeResponse.json([]));
    await flush();
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  });

  test("unmount after PATCH dispatch reports unknown rather than cancellation", async () => {
    const engine = startEngine();
    const changes: boolean[] = [];
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)], {
      onArchivedChange: (_workspaceId, _sessionId, archived) => { changes.push(archived); },
    });
    const late = Promise.withResolvers<Response>();
    const requests = stubFetch(engine, request => request.method === "PATCH" ? late.promise : undefined);
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true }).then(value => { outcome = value; });
    await flush();
    const patch = requests.find(request => request.method === "PATCH");
    expect(patch).toBeDefined();
    await archive.unmount();
    await flush();
    expect(outcome?.kind).toBe("archive_outcome_unknown");
    expect(patch?.signal.aborted).toBe(true);
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(false);
    late.resolve(NativeResponse.json(session("ses_target", "Archive target", 2)));
    await flush();
    expect(changes).toEqual([]);
    expect(requests.filter(request => request.method === "PATCH")).toHaveLength(1);
  });

  test("confirmed human archive releases Stop and reports an unknown PATCH without claiming not archived", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target");
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)]);
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    const requests = stubFetch(engine, request => request.method === "PATCH"
      ? new NativeResponse(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), {
        headers: { "Content-Type": "application/json" },
      }) : undefined);
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true).then(value => { outcome = value; });
    await until(() => dialog() !== null, "human confirmation");
    const confirm = [...document.querySelectorAll("button")].find(button => button.textContent?.trim() === "Stop and archive");
    if (!confirm) throw new Error("Missing Stop and archive");
    jest.useFakeTimers();
    await act(async () => { confirm.click(); });
    await flush();
    expect(body).toBeDefined();
    expect(outcome).toBeUndefined();
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(true);
    await advance(15_000);
    expect(outcome?.kind).toBe("archive_outcome_unknown");
    expect(dialogText()).toContain("Archive outcome is unknown");
    expect(dialogText()).not.toContain("has not been archived");
    expect(document.querySelector('button[disabled]')).toBeNull();
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(false);
    body?.enqueue(new TextEncoder().encode(JSON.stringify(session("ses_target", "Archive target", 2))));
    body?.close();
    await flush();
    expect(requests.filter(request => request.method === "PATCH")).toHaveLength(1);
  });

  test.each(["cache", "reload"])("a known successful PATCH reconciles locally even when %s never settles", async (stage) => {
    const engine = startEngine();
    const reload = Promise.withResolvers<void>();
    if (stage === "cache") {
      const sync = await import("../src/react-app/domains/session/sync/session-sync");
      const apply = spyOn(sync, "applySessionArchived").mockImplementation(() => reload.promise);
      cleanups.push(() => { apply.mockRestore(); });
    }
    const changes: boolean[] = [];
    const archive = await mountArchive(engine, [session("ses_target", "Archive target", 2)], {
      reloadWorkspaceSessions: () => reload.promise,
      onArchivedChange: (_workspaceId, _sessionId, archived) => { changes.push(archived); },
    });
    const requests = stubFetch(engine);
    await act(async () => { useSessionManagementStore.getState().togglePin("ses_target"); });
    cleanups.push(async () => { await act(async () => {
      if (useSessionManagementStore.getState().pinnedIds.includes("ses_target")) useSessionManagementStore.getState().togglePin("ses_target");
    }); });
    jest.useFakeTimers();
    let outcome: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true }).then(value => { outcome = value; });
    await flush();
    expect(outcome?.kind).toBe(stage === "cache" ? undefined : "done");
    expect(changes).toEqual([true]);
    expect(requests.filter(request => request.method === "PATCH")).toHaveLength(1);
    expect(useSessionManagementStore.getState().pinnedIds).toContain("ses_target");
    await advance(3_500);
    expect(outcome?.kind).toBe("done");
    expect(sessionWorkHeld(engine.baseUrl, "ses_target")).toBe(false);
    engine.busy.add("ses_target");
    let retry: ArchiveSessionOutcome | undefined;
    void archive("ses_target", true, { refuseWorking: true }).then(value => { retry = value; });
    await flush();
    expect(retry?.kind).toBe("target_working");
    reload.resolve();
    await flush();
    expect(changes).toEqual([true]);
  });

  test("a stalled bridged archive returns its real deadline error before five seconds including choreography", async () => {
    const engine = startEngine();
    await mountArchive(engine, [session("ses_target", "Archive target", 2)]);
    const late = Promise.withResolvers<Response>();
    const requests = stubFetch(engine, request => new URL(request.url).pathname.endsWith("/message") ? late.promise : undefined);
    const api = window.__openworkControl;
    if (!api) throw new Error("control API was not published");
    const started = performance.now();
    let result: unknown;
    await act(async () => { result = await api.command({ id: "session.archive", args: { sessionId: "ses_target", archived: true } }); });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(result).toMatchObject({ ok: false, code: "verification_failed", error: "Archive operation timed out before it could be confirmed." });
    late.resolve(NativeResponse.json([]));
    await flush();
    expect(requests.some(request => request.method === "PATCH")).toBe(false);
  }, 7_000);

  test.each(["preflight", "patch"])("the real archive control action preserves the %s error through bridge choreography", async (stage) => {
    const engine = startEngine();
    await mountArchive(engine, [session("ses_target", "Archive target", 2)]);
    stubFetch(engine, request => {
      if ((stage === "preflight" && new URL(request.url).pathname.endsWith("/message"))
        || (stage === "patch" && request.method === "PATCH")) {
        return NativeResponse.json({ message: "Engine unavailable for archive" }, { status: 503 });
      }
    });
    const api = window.__openworkControl;
    if (!api) throw new Error("control API was not published");
    const start = Date.now();
    let result: unknown;
    await act(async () => { result = await api.command({ id: "session.archive", args: { sessionId: "ses_target", archived: true } }); });
    expect(Date.now() - start).toBeLessThan(5_000);
    if (!result || typeof result !== "object" || !("error" in result) || typeof result.error !== "string") throw new Error("Missing archive failure");
    expect(result.error).toContain("Engine unavailable for archive");
    if (stage === "patch") expect(result.error).toContain("outcome is unknown");
    expect(result).toMatchObject({ ok: false, code: stage === "patch" ? "archive_outcome_unknown" : "verification_failed" });
  });

  test("the person's own archive of a working session keeps a simple confirmation: title, one question, two buttons", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target");
    const archive = await mountArchive(engine, [session("ses_target", "Payroll import", 2)]);
    let outcome: ArchiveSessionOutcome | null = null;
    void archive("ses_target", true).then((value) => { outcome = value; });
    await until(() => dialog() !== null, "the still-working dialog");
    expect(outcome).toBeNull();
    const text = dialogText();
    expect(text).toContain("This session is still working: Payroll import");
    expect(text).toContain("Stop the current task and archive?");
    expect(text).not.toContain("Requested by");
    expect(text).not.toContain("Session ID");
    expect(text).not.toContain("ses_target");
    expect(dialog()?.querySelectorAll("dl").length).toBe(0);
    expect([...document.querySelectorAll('[role="alertdialog"] button')].map((button) => button.textContent?.trim())).toEqual(["Keep session open", "Stop and archive"]);

    const keep = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Keep session open");
    if (!keep) throw new Error("Keep session open is missing");
    await act(async () => { keep.click(); });
    await until(() => outcome !== null, "cancel to resolve");
    expect(outcome).toEqual({ kind: "cancelled" });
    expect(engine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
  });

  test("session.stop returns every protected structured refusal without aborting", async () => {
    const engine = startEngine();
    engine.busy.add("ses_pinned").add("ses_focused");
    await mountArchive(engine, [
      session("ses_requester", "Requester", 5),
      session("ses_pinned", "Pinned work", 4),
      session("ses_focused", "Focused work", 3),
      session("ses_idle", "Idle work", 2),
    ], { selectedSessionId: "ses_focused" });
    useSessionManagementStore.getState().togglePin("ses_pinned");
    const api = window.__openworkControl;
    if (!api) throw new Error("control API was not published");
    const stop = (sessionId: string, requester?: string) => api.command({
      id: "session.stop",
      args: { sessionId },
      ...(requester === undefined ? {} : { origin: { sessionId: requester } }),
    });

    expect(await stop("ses_pinned")).toMatchObject({ ok: false, code: "unattributed" });
    expect(await stop("ses_missing", "ses_requester")).toMatchObject({ ok: false, code: "not_found" });
    expect(await stop("ses_pinned", "ses_requester")).toMatchObject({ ok: false, code: "pinned" });
    expect(await stop("ses_focused", "ses_requester")).toMatchObject({ ok: false, code: "focused" });
    expect(await stop("ses_idle", "ses_requester")).toMatchObject({ ok: false, code: "not_running" });
    expect(engine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
    expect(engine.busy).toEqual(new Set(["ses_pinned", "ses_focused"]));
  });

  test("session.stop allows a live background target and attributes View to that target", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target");
    await mountArchive(engine, [
      session("ses_requester", "Ops audit", 3),
      session("ses_target", "Payroll import", 2),
    ], { selectedSessionId: "ses_requester" });
    const api = window.__openworkControl;
    if (!api) throw new Error("control API was not published");

    const result = await api.command({
      id: "session.stop",
      args: { sessionId: "ses_target" },
      origin: { sessionId: "ses_requester" },
    });

    expect(result).toMatchObject({ ok: true, result: {
      ok: true, sessionId: "ses_target", title: "Payroll import", stopped: true,
    } });
    expect(engine.busy.size).toBe(0);
    expect(engine.requests).toContain("/session/ses_target/abort");
    expect(useNotificationStore.getState().notifications).toContainEqual(expect.objectContaining({
      title: "Session stopped: Payroll import",
      body: 'Requested by The agent in "Ops audit" ses_requester',
      action: { type: "open-session", workspaceId: "ws", sessionId: "ses_target" },
      actionLabel: "View",
    }));
  });

  test("the focused target may stop itself, but a focused secondary pane refuses another requester", async () => {
    const selfEngine = startEngine();
    selfEngine.busy.add("ses_self");
    await mountArchive(selfEngine, [session("ses_self", "Self", 2)], { selectedSessionId: "ses_self" });
    const firstApi = window.__openworkControl;
    if (!firstApi) throw new Error("control API was not published");
    expect(await firstApi.command({
      id: "session.stop", args: { sessionId: "ses_self" }, origin: { sessionId: "ses_self" },
    })).toMatchObject({ ok: true, result: { ok: true, stopped: true } });

    await cleanups.pop()?.();
    const paneEngine = startEngine();
    paneEngine.busy.add("ses_secondary");
    const sessions = [session("ses_primary", "Primary", 3), session("ses_secondary", "Secondary", 2)];
    await mountArchive(paneEngine, sessions, { selectedSessionId: "ses_primary" });
    const workbench = useWorkbenchStore.getState();
    workbench.sync({
      workspaceId: "ws",
      primarySessionId: "ses_primary",
      sessions: sessions.map((entry) => ({ workspaceId: "ws", sessionId: entry.id, title: entry.title })),
      sessionsKnown: true,
    });
    workbench.openTab({ workspaceId: "ws", sessionId: "ses_secondary", title: "Secondary" });
    workbench.setSplit({ workspaceId: "ws", sessionId: "ses_secondary" });
    workbench.focusPane("secondary");
    const secondApi = window.__openworkControl;
    if (!secondApi) throw new Error("control API was not published");
    expect(await secondApi.command({
      id: "session.stop", args: { sessionId: "ses_secondary" }, origin: { sessionId: "ses_primary" },
    })).toMatchObject({ ok: false, code: "focused" });
    expect(paneEngine.busy).toEqual(new Set(["ses_secondary"]));
    expect(paneEngine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
  });
});
