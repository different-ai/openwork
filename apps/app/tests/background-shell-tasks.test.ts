import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  BACKGROUND_SHELL_FINISHED_EVENT,
  BACKGROUND_SHELL_STARTED_EVENT,
  SHELL_CREATED_EVENT,
  SHELL_DELETED_EVENT,
  SHELL_EXITED_EVENT,
  backgroundShellNoticeLabel,
  readEngineShell,
  runningBackgroundTasksLabel,
  type EngineShell,
} from "../src/app/lib/background-shell-tasks";
import { createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter";
import type { OpencodeEvent } from "../src/app/types";
import {
  addBackgroundShell,
  emptyBackgroundShellBook,
  resyncBackgroundShells,
  markBackgroundShellFreshness,
  sessionBackgroundShells,
  settleBackgroundShell,
  useBackgroundShellStore,
} from "../src/react-app/domains/session/status/background-shell-store";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __reconcileBackgroundShellsForTest,
  __setWorkspaceSessionSyncRunningShellFetcherForTest,
  setBackgroundShellTasksEnabled,
} from "../src/react-app/domains/session/sync/session-sync";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

const SESSION = "ses_background_a";
const OTHER_SESSION = "ses_background_b";
const WORKSPACE = "ws_background";
const sync = { workspaceId: WORKSPACE, baseUrl: "http://127.0.0.1:9/w/ws_background/opencode2", openworkToken: "token" };
const location = { directory: "/tmp/background" };

function shellInfo(id: string, sessionID: string, command = "sleep 20; echo done") {
  return { id, status: "running", command, cwd: location.directory, shell: "/bin/zsh", file: `/tmp/${id}.out`, pid: 1, metadata: { sessionID }, time: { started: 1_000 } };
}

function engineShell(id: string, sessionID: string | null, command = "sleep 20; echo done"): EngineShell {
  return { id, status: "running", command, sessionID, startedAt: 1_000, exit: null };
}

/** The engine's events for one shell tool call, as /api/event sends them. */
function shellToolCall(callID: string, success: Record<string, unknown>, sessionID = SESSION) {
  const base = { sessionID, messageID: `msg_${callID}`, callID };
  return [
    { type: "session.tool.input.started", created: 1, location, data: { ...base, name: "shell" } },
    { type: "session.tool.called", created: 2, location, data: { ...base, input: { command: "sleep 20; echo done", background: true } } },
    { type: "session.tool.success", created: 3, location, data: { ...base, ...success } },
  ];
}

function translateAll(events: unknown[]): OpencodeEvent[] {
  const state = createV2EventTranslationState();
  return events.flatMap((event) => translateV2Event(event, state) ?? []);
}

function inboxNotice(shellID: string, state = "completed", exit = 0) {
  return {
    type: "session.inbox.enqueued", created: 10, location,
    data: {
      sessionID: SESSION, inboxID: `msg_notice_${shellID}`,
      item: { type: "synthetic", payload: {
        metadata: { source: "shell", shellID, jobID: shellID, state, exit, truncated: false },
        text: `<shell id="${shellID}" state="${state}" command="sleep 20; echo done">\ndone\n</shell>`,
        description: "sleep 20; echo done",
      } },
    },
  };
}

function sessionCount(sessionId = SESSION) {
  return sessionBackgroundShells(useBackgroundShellStore.getState().booksByWorkspaceId[WORKSPACE]?.running, sessionId).length;
}

describe("translating engine shell events", () => {
  afterEach(() => setBackgroundShellTasksEnabled(false));

  test("a background shell call reports its running shell, with the command it runs", () => {
    const events = translateAll(shellToolCall("call_bg", { metadata: { status: "running", shellID: "sh_bg1" } }));
    const started = events.find((event) => event.type === BACKGROUND_SHELL_STARTED_EVENT);
    expect(started?.properties).toMatchObject({ sessionID: SESSION, shellID: "sh_bg1", command: "sleep 20; echo done" });
    // The tool row itself still completes as before.
    expect(events.some((event) => event.type === "message.part.updated")).toBe(true);
  });

  test("a foreground shell call never reports a background shell", () => {
    const events = translateAll(shellToolCall("call_fg", { metadata: { status: "completed", exit: 0, shellID: "sh_fg1" } }));
    expect(events.some((event) => event.type === BACKGROUND_SHELL_STARTED_EVENT)).toBe(false);
  });

  test("shell lifecycle events pass through with their ids", () => {
    const events = translateAll([
      { type: "shell.created", created: 1, location, data: { info: shellInfo("sh_life", SESSION) } },
      { type: "shell.exited", created: 2, location, data: { id: "sh_life", exit: 0, status: "exited" } },
      { type: "shell.deleted", created: 3, location, data: { id: "sh_life" } },
    ]);
    expect(events.map((event) => event.type)).toEqual([SHELL_CREATED_EVENT, SHELL_EXITED_EVENT, SHELL_DELETED_EVENT]);
    expect(readEngineShell(events[0]?.properties)).toMatchObject({ id: "sh_life", sessionID: SESSION, command: "sleep 20; echo done" });
    expect(events[1]?.properties).toEqual({ id: "sh_life", status: "exited", exit: 0 });
  });

  test("with the feature off, a completion notice is still dropped from the transcript", () => {
    const events = translateAll([inboxNotice("sh_off")]);
    expect(events.map((event) => event.type)).toEqual([BACKGROUND_SHELL_FINISHED_EVENT]);
  });

  test("with the feature on, a completion notice is one plain row, never the raw <shell> text", () => {
    setBackgroundShellTasksEnabled(true);
    const events = translateAll([inboxNotice("sh_on")]);
    expect(events.map((event) => event.type)).toEqual([BACKGROUND_SHELL_FINISHED_EVENT, "message.updated", "message.part.updated"]);
    expect(events[1]?.properties).toMatchObject({ info: { id: "msg_notice_sh_on", role: "system", sessionID: SESSION } });
    expect(events[2]?.properties).toMatchObject({ part: {
      type: "text", text: "Background task finished",
      metadata: { openworkBackgroundShell: { shellId: "sh_on", command: "sleep 20; echo done", outcome: "finished", exit: 0 } },
    } });
    expect(JSON.stringify(events)).not.toContain("<shell");
  });

  test("completion rows say how the command ended", () => {
    expect(backgroundShellNoticeLabel({ outcome: "failed", exit: 2 })).toBe("Background task failed");
    expect(backgroundShellNoticeLabel({ outcome: "timed-out", exit: null })).toBe("Background task timed out");
    expect(runningBackgroundTasksLabel(1)).toBe("1 running background task");
    expect(runningBackgroundTasksLabel(2)).toBe("2 running background tasks");
  });
});

describe("the background shell book", () => {
  const shell = (id: string, sessionId = SESSION, observedAt = 100) => ({ id, sessionId, command: "sleep 20", startedAt: 1, observedAt });

  test("an exit settles a shell, and a late start cannot bring it back", () => {
    let book = addBackgroundShell(emptyBackgroundShellBook, shell("sh_1"));
    book = settleBackgroundShell(book, "sh_1");
    book = addBackgroundShell(book, shell("sh_1"));
    expect(Object.keys(book.running)).toEqual([]);
  });

  test("a resync drops what the engine no longer runs, keeps what it learned after the read began, and admits only background commands", () => {
    let book = addBackgroundShell(emptyBackgroundShellBook, shell("sh_stale", SESSION, 100));
    book = addBackgroundShell(book, shell("sh_new", SESSION, 500));
    book = addBackgroundShell(book, shell("sh_kept", SESSION, 100));
    book = resyncBackgroundShells(book, {
      listed: [engineShell("sh_kept", SESSION), engineShell("sh_foreground", SESSION), engineShell("sh_missed", SESSION), engineShell("sh_orphan", null)],
      startedAt: 200,
      sessionIds: "all",
      admit: (listed) => listed.id === "sh_missed",
    });
    expect(Object.keys(book.running).sort()).toEqual(["sh_kept", "sh_missed", "sh_new"]);
    expect(book.settled).toContain("sh_stale");
  });

  test("a failed check retains the last known count and age without overriding a newer check", () => {
    let book = addBackgroundShell(emptyBackgroundShellBook, shell("sh_known"));
    book = markBackgroundShellFreshness(book, "all", 200);
    book = markBackgroundShellFreshness(book, "all", undefined, 300);
    expect(book.running.sh_known).toMatchObject({ stale: true, checkedAt: 200 });
    expect(Object.keys(book.running)).toEqual(["sh_known"]);
    book = markBackgroundShellFreshness(book, "all", 500);
    book = markBackgroundShellFreshness(book, "all", undefined, 400);
    expect(book.running.sh_known).toMatchObject({ stale: false, checkedAt: 500 });
  });

  test("a resync for one conversation leaves the others alone", () => {
    let book = addBackgroundShell(emptyBackgroundShellBook, shell("sh_a", SESSION));
    book = addBackgroundShell(book, shell("sh_b", OTHER_SESSION));
    book = resyncBackgroundShells(book, {
      listed: [engineShell("sh_b2", OTHER_SESSION)], startedAt: 200, sessionIds: new Set([SESSION]), admit: () => true,
    });
    expect(Object.keys(book.running)).toEqual(["sh_b"]);
  });
});

describe("session sync", () => {
  let dispose: () => void = () => {};
  beforeEach(() => {
    setBackgroundShellTasksEnabled(true);
    useSessionActivityStore.setState({ recordsByWorkspaceId: {} });
    dispose = __createWorkspaceSessionSyncForTest(sync);
  });
  afterEach(() => {
    dispose();
    __setWorkspaceSessionSyncRunningShellFetcherForTest(null);
    setBackgroundShellTasksEnabled(false);
  });

  const apply = (events: unknown[]) => {
    for (const event of translateAll(events)) __applySessionSyncEventForTest(sync, event);
  };

  test("a background call adds a task, and its exit, deletion or completion notice removes it", () => {
    apply([{ type: "shell.created", created: 1, location, data: { info: shellInfo("sh_exit", SESSION) } }]);
    apply(shellToolCall("call_exit", { metadata: { status: "running", shellID: "sh_exit" } }));
    expect(sessionCount()).toBe(1);
    expect(sessionBackgroundShells(useBackgroundShellStore.getState().booksByWorkspaceId[WORKSPACE]?.running, SESSION)[0]?.command).toBe("sleep 20; echo done");
    apply([{ type: "shell.exited", created: 4, location, data: { id: "sh_exit", exit: 0, status: "exited" } }]);
    expect(sessionCount()).toBe(0);

    apply(shellToolCall("call_delete", { metadata: { status: "running", shellID: "sh_delete" } }));
    apply(shellToolCall("call_notice", { metadata: { status: "running", shellID: "sh_notice" } }));
    expect(sessionCount()).toBe(2);
    apply([{ type: "shell.deleted", created: 5, location, data: { id: "sh_delete" } }]);
    expect(sessionCount()).toBe(1);
    apply([inboxNotice("sh_notice")]);
    expect(sessionCount()).toBe(0);
  });

  test("a foreground shell is never counted, even when a resync lists it while its conversation runs", async () => {
    useSessionActivityStore.getState().setRunStatus(WORKSPACE, SESSION, { type: "busy" });
    apply([{ type: "shell.created", created: 1, location, data: { info: shellInfo("sh_fg", SESSION) } }]);
    apply(shellToolCall("call_fg", { metadata: { status: "completed", exit: 0 } }));
    __setWorkspaceSessionSyncRunningShellFetcherForTest(async () => [engineShell("sh_fg", SESSION)]);
    await __reconcileBackgroundShellsForTest(sync, "all");
    expect(sessionCount()).toBe(0);
  });

  test("a resync drops a task whose exit was missed, and picks up one started while disconnected", async () => {
    apply(shellToolCall("call_lost", { metadata: { status: "running", shellID: "sh_lost_exit" } }));
    expect(sessionCount()).toBe(1);
    useSessionActivityStore.getState().setRunStatus(WORKSPACE, SESSION, { type: "idle" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    __setWorkspaceSessionSyncRunningShellFetcherForTest(async () => [engineShell("sh_started_offline", SESSION)]);
    await __reconcileBackgroundShellsForTest(sync, SESSION);
    const shells = sessionBackgroundShells(useBackgroundShellStore.getState().booksByWorkspaceId[WORKSPACE]?.running, SESSION);
    expect(shells.map((shell) => shell.id)).toEqual(["sh_started_offline"]);
  });

  test("a failed running-command read marks retained commands uncertain until a successful reconciliation", async () => {
    apply(shellToolCall("call_uncertain", { metadata: { status: "running", shellID: "sh_uncertain" } }));
    __setWorkspaceSessionSyncRunningShellFetcherForTest(async () => { throw new Error("fixture connection refused"); });
    await __reconcileBackgroundShellsForTest(sync, SESSION);
    expect(sessionCount()).toBe(1);
    expect(useBackgroundShellStore.getState().booksByWorkspaceId[WORKSPACE]?.running.sh_uncertain?.stale).toBe(true);
    __setWorkspaceSessionSyncRunningShellFetcherForTest(async () => [engineShell("sh_uncertain", SESSION)]);
    await __reconcileBackgroundShellsForTest(sync, SESSION);
    expect(sessionCount()).toBe(1);
    expect(useBackgroundShellStore.getState().booksByWorkspaceId[WORKSPACE]?.running.sh_uncertain?.stale).toBe(false);
  });

  test("another conversation's commands are not counted for this one", async () => {
    apply(shellToolCall("call_other", { metadata: { status: "running", shellID: "sh_other" } }, OTHER_SESSION));
    expect(sessionCount()).toBe(0);
    expect(sessionCount(OTHER_SESSION)).toBe(1);
    // Resyncing this conversation leaves the other one's task alone.
    __setWorkspaceSessionSyncRunningShellFetcherForTest(async () => []);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await __reconcileBackgroundShellsForTest(sync, SESSION);
    expect(sessionCount(OTHER_SESSION)).toBe(1);
  });

  test("with the feature off, shell events change nothing", () => {
    setBackgroundShellTasksEnabled(false);
    apply(shellToolCall("call_off", { metadata: { status: "running", shellID: "sh_off" } }));
    expect(useBackgroundShellStore.getState().booksByWorkspaceId).toEqual({});
  });
});
