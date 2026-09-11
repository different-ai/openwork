/** @jsxImportSource react */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";

import type { ResolvedWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { ArchiveSessionOptions, ArchiveSessionOutcome } from "../src/react-app/domains/session/sidebar/use-session-archive";
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

  test("only finished or failed turns are safe to archive without Stop", () => {
    expect(["thinking", "responding", "waiting", "compacting"].map(isWorkingStatus)).toEqual([true, true, true, true]);
    expect(["idle", "error"].map(isWorkingStatus)).toEqual([false, false]);
  });
});

describe("control bridge contract for human-gated commands", () => {
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

  test("a dialog only the person can answer is reported to the bridge at once, while the window caller keeps waiting", async () => {
    let finish: (() => void) | null = null;
    let executions = 0;
    const api = await mountAction({
      id: "test.gated",
      label: "Gated",
      sideEffect: "mutation",
      execute: (_args, helpers) => new Promise((resolve) => {
        executions += 1;
        helpers.awaitingUserConfirmation?.({ error: "Still working; the person was asked.", hint: "Do not retry." });
        finish = () => resolve({ ok: false, error: "cancelled by the person" });
      }),
    });

    const bridged = await api.command({ id: "test.gated", origin: { sessionId: "ses_requester" } });
    expect(bridged).toMatchObject({
      ok: false,
      id: "test.gated",
      code: "awaiting_user_confirmation",
      error: "Still working; the person was asked.",
      hint: "Do not retry.",
    });
    expect(executions).toBe(1);
    // The dialog is still open: the app stays busy on that command rather than
    // running a second lifecycle action on top of an unanswered one.
    expect(await api.command({ id: "test.gated" })).toMatchObject({ ok: false, code: "conflict" });
    if (!finish) throw new Error("action did not start");
    finish();
    await until(() => api.snapshot().busyActionId === null, "gated action to release");

    let settled = false;
    const direct = api.execute("test.gated").then((result) => { settled = true; return result; });
    await until(() => executions === 2, "window caller to reach the action");
    await settle(30);
    expect(settled).toBe(false);
    if (!finish) throw new Error("action did not start");
    finish();
    expect(await direct).toMatchObject({ ok: false, error: "cancelled by the person" });
  });

  test("an action's structured code and hint reach the bridge unchanged", async () => {
    const api = await mountAction({
      id: "test.coded",
      label: "Coded",
      sideEffect: "mutation",
      execute: () => ({ ok: false, code: "conflict", error: "Busy elsewhere.", hint: "Try later." }),
    });
    expect(await api.command({ id: "test.coded", origin: { sessionId: "ses_requester" } })).toMatchObject({
      ok: false,
      code: "conflict",
      error: "Busy elsewhere.",
      hint: "Try later.",
    });
    expect(await api.execute("test.coded")).toMatchObject({ ok: false, code: "conflict", hint: "Try later." });
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

describe("archiving a working session tells the person who asked", () => {
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
        const session = /^\/session\/([^/]+)(\/(children|message))?$/.exec(url.pathname);
        if (session) {
          const [, id, , sub] = session;
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
      useEffect(() => { archiveSession = archive.archiveSession; });
      return archive.archiveDialog;
    }
    await act(async () => root.render(<MemoryRouter><Harness /></MemoryRouter>));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    if (!archiveSession) throw new Error("archive hook did not mount");
    return archiveSession;
  }

  const errors = spyOn(toast, "error").mockImplementation(() => "");
  cleanups.push(() => { errors.mockClear(); });
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const dialogText = () => dialog()?.textContent ?? "";

  test("another agent archiving a working session opens the dialog naming target and requester, and answers the bridge first", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target");
    const archive = await mountArchive(engine, [session("ses_target", "Payroll import", 2), session("ses_requester", "Ops audit", 3)]);
    const awaiting: unknown[] = [];
    let outcome: ArchiveSessionOutcome | null = null;
    void archive("ses_target", true, {
      requester: { sessionId: "ses_requester" },
      onAwaitingConfirmation: (target) => awaiting.push(target),
    }).then((value) => { outcome = value; });

    await until(() => dialog() !== null, "the still-working dialog");
    expect(awaiting).toEqual([{ sessionId: "ses_target", title: "Payroll import", requestedBy: { sessionId: "ses_requester", title: "Ops audit" } }]);
    expect(outcome).toBeNull();
    const text = dialogText();
    expect(text).toContain("This session is still working: Payroll import");
    expect(text).toContain("Session ID");
    expect(text).toContain("ses_target");
    expect(text).toContain("Requested by");
    expect(text).toContain('The agent in "Ops audit"');
    expect(text).toContain("ses_requester");
    expect(text).toContain("Client A / Production");

    const keep = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Keep session open");
    if (!keep) throw new Error("Keep session open is missing");
    await act(async () => { keep.click(); });
    await until(() => outcome !== null, "cancel to resolve");
    expect(outcome).toBe("cancelled");
    expect(engine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  test("a session archiving itself mid-turn is attributed as this session itself", async () => {
    const engine = startEngine();
    engine.busy.add("ses_parent").add("ses_child");
    engine.children.ses_parent = ["ses_child"];
    const archive = await mountArchive(engine, [session("ses_parent", "Parent work", 1)]);
    const awaiting: unknown[] = [];
    void archive("ses_parent", true, { requester: { sessionId: "ses_parent" }, onAwaitingConfirmation: (target) => awaiting.push(target) });
    await until(() => dialog() !== null, "the still-working dialog");
    expect(awaiting).toEqual([{ sessionId: "ses_parent", title: "Parent work", requestedBy: { sessionId: "ses_parent", title: "Parent work" } }]);
    const text = dialogText();
    expect(text).toContain("Requested by");
    expect(text).toContain("This session itself, from its own running turn");
    expect(text).not.toContain('The agent in "Parent work"');
    expect(engine.requests.some((path) => path.endsWith("/abort"))).toBe(false);
  });

  test("a request without a known requester keeps the two-row dialog", async () => {
    const engine = startEngine();
    engine.busy.add("ses_target");
    const archive = await mountArchive(engine, [session("ses_target", "Payroll import", 2)]);
    void archive("ses_target", true);
    await until(() => dialog() !== null, "the still-working dialog");
    expect(dialogText()).not.toContain("Requested by");
    expect(dialog()?.querySelectorAll("dt").length).toBe(2);
  });
});
