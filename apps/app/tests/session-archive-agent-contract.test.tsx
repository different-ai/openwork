/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { ArchiveSessionOptions, ArchiveSessionOutcome, StopSessionOutcome } from "../src/react-app/domains/session/sidebar/use-session-archive";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";
import type { OpenworkControlAPI, OpenworkControlAction } from "../src/react-app/shell/control/control-provider";

// The archive hook talks to a real (fake) engine over HTTP; happy-dom's fetch
// polyfill cannot parse Bun.serve responses, so keep the runtime's fetch.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "fetch", { configurable: true, value: nativeFetch });
Object.defineProperty(window, "fetch", { configurable: true, value: nativeFetch });
// Base UI picks its layout-effect shim at module load, so the app must be
// imported after the DOM exists or the dialog portal never mounts.
const [
  { createOpenworkServerClient },
  { toast, Toaster },
  { isWorkingStatus, listControlSessions },
  { useSessionArchive },
  { OpenworkControlProvider, useControlAction },
  { useNotificationStore },
] = await Promise.all([
  import("../src/app/lib/openwork-server"),
  import("../src/components/ui/sonner"),
  import("../src/react-app/domains/session/control/list-control-sessions"),
  import("../src/react-app/domains/session/sidebar/use-session-archive"),
  import("../src/react-app/shell/control/control-provider"),
  import("../src/react-app/kernel/notification-store"),
]);
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
    expect(await api.command({ id: "test.channel", origin: { sessionId: "ses_requester" } })).toMatchObject({ ok: true });
    expect(await api.execute("test.channel")).toMatchObject({ ok: true });
    expect(seen).toEqual([true, false]);
  });

  test("an action's structured code and hint reach the bridge unchanged", async () => {
    const api = await mountAction({
      id: "test.coded",
      label: "Coded",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "target_working", error: "Busy elsewhere.", hint: "Stop it first." }),
    });
    expect(await api.command({ id: "test.coded", origin: { sessionId: "ses_requester" } })).toMatchObject({
      ok: false,
      code: "target_working",
      error: "Busy elsewhere.",
      hint: "Stop it first.",
    });
    expect(await api.execute("test.coded")).toMatchObject({ ok: false, code: "target_working", hint: "Stop it first." });
  });

  test("unknown codes fall back to failed so the schema stays closed", async () => {
    const api = await mountAction({
      id: "test.odd",
      label: "Odd",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "made_up", error: "Nope." }),
    });
    expect(await api.command({ id: "test.odd" })).toMatchObject({ ok: false, code: "failed", error: "Nope." });
  });
});

describe("archiving a working session: the warning goes back through the request's channel", () => {
  const directory = "/tmp/archive-contract";
  type Engine = { baseUrl: string; busy: Set<string>; children: Record<string, string[]>; requests: string[] };

  function startEngine(): Engine {
    const engine: Engine = { baseUrl: "", busy: new Set(), children: {}, requests: [] };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
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
    });
    engine.baseUrl = `http://127.0.0.1:${server.port}`;
    cleanups.push(() => server.stop(true));
    return engine;
  }

  function session(id: string, title: string, updated: number): RouteSession {
    return { id, slug: id, projectID: "prj", directory, title, version: "1", time: { created: 1, updated } };
  }

  async function mountArchive(engine: Engine, sessions: RouteSession[]) {
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
        selectedSessionId: null,
        draftScope: null,
        navigateToWorkspaceSession: () => undefined,
        reloadWorkspaceSessions: async () => undefined,
        onArchivedChange: () => undefined,
      });
      useEffect(() => { archiveSession = archive.archiveSession; stopSession = archive.stopSession; });
      return archive.archiveDialog;
    }
    await act(async () => root.render(<MemoryRouter><Harness /></MemoryRouter>));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    if (!archiveSession || !stopSession) throw new Error("archive hook did not mount");
    return Object.assign(archiveSession, { stop: stopSession });
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
});

describe("session.stop: the Stop button for any loaded session, attributed to who asked", () => {
  const directory = "/tmp/stop-contract";
  type Engine = { baseUrl: string; busy: Set<string>; children: Record<string, string[]>; requests: string[] };

  function startEngine(): Engine {
    const engine: Engine = { baseUrl: "", busy: new Set(), children: {}, requests: [] };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        engine.requests.push(`${request.method} ${url.pathname}`);
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
            for (const child of engine.children[id] ?? []) engine.busy.delete(child);
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
    });
    engine.baseUrl = `http://127.0.0.1:${server.port}`;
    cleanups.push(() => server.stop(true));
    return engine;
  }

  function session(id: string, title: string, updated: number): RouteSession {
    return { id, slug: id, projectID: "prj", directory, title, version: "1", time: { created: 1, updated } };
  }

  async function mountStop(engine: Engine, sessions: RouteSession[]) {
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
    const navigations: string[] = [];
    let stopSession: ((sessionId: string, options?: ArchiveSessionOptions) => Promise<StopSessionOutcome>) | null = null;
    function Harness() {
      const archive = useSessionArchive({
        workspaces: [workspace],
        sessionsByWorkspaceId: { ws: sessions },
        endpointForWorkspace: () => endpoint,
        selectedWorkspaceId: "ws",
        selectedSessionId: null,
        draftScope: null,
        navigateToWorkspaceSession: (workspaceId, sessionId) => { navigations.push(`${workspaceId}/${sessionId}`); },
        reloadWorkspaceSessions: async () => undefined,
        onArchivedChange: () => undefined,
      });
      useEffect(() => { stopSession = archive.stopSession; });
      return <>{archive.archiveDialog}<Toaster /></>;
    }
    await act(async () => root.render(<MemoryRouter><Harness /></MemoryRouter>));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    if (!stopSession) throw new Error("archive hook did not mount");
    return { stop: stopSession, navigations };
  }

  const notifications = () => useNotificationStore.getState().notifications;
  beforeEach(() => { useNotificationStore.getState().clearAll(); });

  test("stopping a working session aborts its tree, navigates nowhere, and notifies who asked", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target").add("ses_child");
    engine.children.ses_target = ["ses_child"];
    const { stop, navigations } = await mountStop(engine, [session("ses_target", "Payroll import", 2), session("ses_requester", "Ops audit", 3)]);

    let outcome: StopSessionOutcome | null = null;
    void stop("ses_target", { requester: { sessionId: "ses_requester" } }).then((value) => { outcome = value; });
    await until(() => outcome !== null, "stop to resolve");
    expect(outcome).toEqual({ ok: true, sessionId: "ses_target", title: "Payroll import", stopped: true });
    expect(engine.requests).toContain("POST /session/ses_target/abort");
    expect(engine.busy.size).toBe(0);
    expect(navigations).toEqual([]);
    expect(dialog()).toBeNull();

    const entry = notifications().find((notification) => notification.title === "Session stopped: Payroll import");
    expect(entry).toMatchObject({
      kind: "system",
      severity: "info",
      body: 'Requested by The agent in "Ops audit" ses_requester',
      action: { type: "open-session", workspaceId: "ws", sessionId: "ses_target" },
      actionLabel: "View",
    });
    // The same wording reaches the immediate toast.
    await until(() => document.body.textContent?.includes("Session stopped: Payroll import") === true, "stop toast");
    expect(document.body.textContent).toContain('Requested by The agent in "Ops audit" ses_requester');
  });

  test("stopping an idle session is a no-op that says so", async () => {
    const engine = startEngine();
    const { stop } = await mountStop(engine, [session("ses_idle", "Quiet", 1)]);
    let outcome: StopSessionOutcome | null = null;
    void stop("ses_idle", { requester: { sessionId: "ses_other" } }).then((value) => { outcome = value; });
    await until(() => outcome !== null, "idle stop to resolve");
    expect(outcome).toEqual({ ok: true, sessionId: "ses_idle", title: "Quiet", alreadyIdle: true });
    expect(engine.requests.some((entry) => entry.endsWith("/abort"))).toBe(false);
    expect(notifications().some((notification) => notification.title.startsWith("Session stopped"))).toBe(false);
  });

  test("an unknown session id is a structured error, not a dialog", async () => {
    const engine = startEngine();
    const { stop } = await mountStop(engine, [session("ses_known", "Known", 1)]);
    expect(await stop("ses_missing")).toEqual({ ok: false, sessionId: "ses_missing", error: "Session was not found in the current session list" });
    expect(engine.requests).toEqual([]);
    expect(dialog()).toBeNull();
  });

  const dialog = () => document.querySelector('[role="alertdialog"]');
});
