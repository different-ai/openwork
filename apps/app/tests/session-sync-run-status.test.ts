import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __disposeWorkspaceSessionSyncForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __setWorkspaceSessionSyncSubscriptionFactoryForTest,
  ensureWorkspaceSessionSync,
  markSessionSnapshotFetchStart,
  seedSessionState,
  snapshotKey,
  statusKey,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

type SyncInput = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
};

type Subscription = {
  signal: AbortSignal;
  end: () => void;
};

const workspaceId = "workspace-run-status";
const sessionId = "session-run-status";
const syncInputs: SyncInput[] = [];
const subscriptions: Subscription[] = [];

function createSnapshot(status: SessionStatus): OpenworkSessionSnapshot {
  return {
    session: {
      id: sessionId,
      slug: sessionId,
      projectID: "project-run-status",
      directory: "/tmp/project-run-status",
      title: "Run status test",
      version: "1",
      time: { created: 1, updated: 1 },
    },
    messages: [],
    todos: [],
    status,
  };
}

function createSyncInput(): SyncInput {
  const input = {
    workspaceId,
    baseUrl: "https://run-status.example/opencode",
    openworkToken: "token",
  };
  syncInputs.push(input);
  return input;
}

function createTestSync() {
  const input = createSyncInput();
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  const releaseSession = trackWorkspaceSessionSync(input, sessionId);
  return { input, cleanup, releaseSession };
}

async function createSubscription(_baseUrl: string, _token: string, signal: AbortSignal) {
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  signal.addEventListener("abort", end, { once: true });
  async function* stream() {
    await ended;
  }
  subscriptions.push({ signal, end });
  return stream();
}

async function waitForSubscriptions(count: number) {
  const deadline = Date.now() + 2_000;
  while (subscriptions.length < count && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(subscriptions).toHaveLength(count);
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function applyStatus(input: SyncInput, status: SessionStatus) {
  __applySessionSyncEventForTest(input, {
    type: "session.status",
    properties: { sessionID: sessionId, status },
  });
}

function applyCompletedToolAndFinalAnswer(input: SyncInput) {
  __applySessionSyncEventForTest(input, {
    type: "message.updated",
    properties: {
      info: {
        id: "assistant-tool",
        role: "assistant",
        sessionID: sessionId,
        time: { created: 1, completed: 2 },
      },
    },
  } as any);
  __applySessionSyncEventForTest(input, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-tool",
        sessionID: sessionId,
        messageID: "assistant-tool",
        type: "tool",
        callID: "call-tool",
        tool: "lookup",
        state: {
          status: "completed",
          input: { query: "fixture" },
          output: "fixture result",
          title: "Lookup",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    },
  } as any);
  __applySessionSyncEventForTest(input, {
    type: "message.updated",
    properties: {
      info: {
        id: "assistant-final",
        role: "assistant",
        sessionID: sessionId,
        time: { created: 3, completed: 4 },
      },
    },
  } as any);
  __applySessionSyncEventForTest(input, {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part-final",
        sessionID: sessionId,
        messageID: "assistant-final",
        type: "text",
        text: "The final answer is visible.",
      },
    },
  } as any);
}

afterEach(() => {
  jest.useRealTimers();
  for (const input of syncInputs) __disposeWorkspaceSessionSyncForTest(input);
  syncInputs.length = 0;
  subscriptions.length = 0;
  __setWorkspaceSessionSyncSubscriptionFactoryForTest(null);
  __setWorkspaceSessionSyncStatusFetcherForTest(null);
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  getReactQueryClient().clear();
  setSystemTime();
});

describe("session run status ordering", () => {
  test("preserves the activity snapshot when workspace seeds are unchanged", () => {
    const store = useSessionActivityStore.getState();
    store.seedWorkspaceSessions(workspaceId, [{ id: sessionId, status: { type: "idle" } }]);
    const before = useSessionActivityStore.getState();
    let notifications = 0;
    const unsubscribe = useSessionActivityStore.subscribe(() => {
      notifications += 1;
    });

    for (let index = 0; index < 60; index += 1) {
      useSessionActivityStore.getState().seedWorkspaceSessions(
        workspaceId,
        [{ id: sessionId, status: { type: "idle" } }],
      );
    }

    expect(useSessionActivityStore.getState()).toBe(before);
    expect(notifications).toBe(0);

    useSessionActivityStore.getState().seedWorkspaceSessions(
      workspaceId,
      [{ id: sessionId, status: { type: "busy" } }],
    );
    unsubscribe();

    expect(useSessionActivityStore.getState()).not.toBe(before);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
    expect(notifications).toBe(1);
  });

  test("does not publish duplicate activity observations", () => {
    useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" });
    useSessionActivityStore.getState().markMessageRole(workspaceId, sessionId, "assistant-1", "assistant");
    useSessionActivityStore.getState().markAssistantOutput(workspaceId, sessionId, "assistant-1");
    const before = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId];
    let notifications = 0;
    const unsubscribe = useSessionActivityStore.subscribe(() => {
      notifications += 1;
    });

    useSessionActivityStore.getState().markMessageRole(workspaceId, sessionId, "assistant-1", "assistant");
    useSessionActivityStore.getState().markAssistantOutput(workspaceId, sessionId, "assistant-1");
    useSessionActivityStore.getState().replaceWaitingRequests(workspaceId, sessionId, "permission", []);
    useSessionActivityStore.getState().clearError(workspaceId, sessionId);
    useSessionActivityStore.getState().setCompacting(workspaceId, sessionId, false);

    unsubscribe();
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]).toBe(before);
    expect(notifications).toBe(0);
  });

  test("invalidates the durable snapshot when a tracked run becomes idle", () => {
    const { input, cleanup, releaseSession } = createTestSync();
    const queryClient = getReactQueryClient();
    queryClient.setQueryData(snapshotKey(workspaceId, sessionId), createSnapshot({ type: "busy" }));

    __applySessionSyncEventForTest(input, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    });

    expect(queryClient.getQueryState(snapshotKey(workspaceId, sessionId))?.isInvalidated).toBe(true);

    releaseSession();
    cleanup();
  });

  test("clears the busy status cache when a run errors without a following idle", () => {
    const statusUpdates: SessionStatus[] = [];
    const input = {
      workspaceId,
      baseUrl: "https://run-status.example/opencode",
      openworkToken: "token",
      onSessionStatus: (update: { sessionId: string; status: SessionStatus }) => {
        statusUpdates.push(update.status);
      },
    };
    syncInputs.push(input);
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const releaseSession = trackWorkspaceSessionSync(input, sessionId);

    applyStatus(input, { type: "busy" });
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "busy" });

    __applySessionSyncEventForTest(input, {
      type: "session.error",
      properties: {
        sessionID: sessionId,
        error: { name: "UnknownError", data: { message: "provider exploded" } },
      },
    });

    // The chat surface derives its thread status from this cache: an errored
    // run must stop reading busy, or the "Working…" row ticks forever beside
    // the error card when the engine never sends a follow-up idle event.
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "idle" });
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.status).toBe("error");
    // Status listeners (like the queued-send drainer) get the same idle edge
    // session.idle would have delivered, so queued sends are not wedged.
    expect(statusUpdates.at(-1)).toEqual({ type: "idle" });

    releaseSession();
    cleanup();
  });

  test("does not resurrect a finished run from a stale busy snapshot", () => {
    const { input, cleanup, releaseSession } = createTestSync();
    const snapshot = createSnapshot({ type: "busy" });
    markSessionSnapshotFetchStart(snapshot, 100);

    setSystemTime(200);
    applyStatus(input, { type: "busy" });
    setSystemTime(300);
    __applySessionSyncEventForTest(input, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    });
    seedSessionState(workspaceId, snapshot);

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.status).toBe("idle");
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "idle" });

    releaseSession();
    cleanup();
  });

  test("does not let an older idle snapshot stop a live run", () => {
    setSystemTime(200);
    useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" });

    useSessionActivityStore.getState().seedSessionRun(
      workspaceId,
      sessionId,
      { type: "idle" },
      false,
      { snapshotStartedAt: 100 },
    );

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive).toBe(true);
  });

  test("lets a newer idle snapshot heal a stale active record", () => {
    setSystemTime(100);
    useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" });

    useSessionActivityStore.getState().seedSessionRun(
      workspaceId,
      sessionId,
      { type: "idle" },
      false,
      { snapshotStartedAt: 200 },
    );

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.status).toBe("idle");
  });

  test("ignores run state from unmarked snapshot objects", () => {
    setSystemTime(100);
    useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "idle" });
    getReactQueryClient().setQueryData(statusKey(workspaceId, sessionId), { type: "idle" });

    seedSessionState(workspaceId, createSnapshot({ type: "busy" }));

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.status).toBe("idle");
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "idle" });
  });

  test("preserves assistant output when an active seed omits it", () => {
    setSystemTime(100);
    useSessionActivityStore.getState().setRunStatus(workspaceId, sessionId, { type: "busy" });
    useSessionActivityStore.getState().markAssistantOutput(workspaceId, sessionId);

    useSessionActivityStore.getState().seedSessionRun(
      workspaceId,
      sessionId,
      { type: "busy" },
      undefined,
      { snapshotStartedAt: 200 },
    );

    const record = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId];
    expect(record?.assistantOutput).toBe(true);
    expect(record?.status).toBe("responding");
  });
});

describe("session run status reconnect reconciliation", () => {
  test("seeds a missed busy edge into the status cache on connect", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({ [sessionId]: { type: "busy" } }));
    setSystemTime(100);
    const input = createSyncInput();
    ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, sessionId);
    await waitForSubscriptions(1);
    await flushMicrotasks();

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.status).toBe("thinking");
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "busy" });

    releaseSession();
  });

  test("does not clobber a newer live status with a stale reconnect fetch", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    let resolveStatuses: (statuses: Record<string, SessionStatus>) => void = () => {};
    __setWorkspaceSessionSyncStatusFetcherForTest(() => new Promise((resolve) => {
      resolveStatuses = resolve;
    }));
    setSystemTime(100);
    const input = createSyncInput();
    ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, sessionId);
    await waitForSubscriptions(1);
    await flushMicrotasks();

    setSystemTime(200);
    applyStatus(input, { type: "busy" });
    resolveStatuses({});
    await flushMicrotasks();

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive).toBe(true);
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "busy" });

    releaseSession();
  });

  test("does not resurrect an idle run from an older reconnect snapshot", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    let resolveStatuses: (statuses: Record<string, SessionStatus>) => void = () => {};
    __setWorkspaceSessionSyncStatusFetcherForTest(() => new Promise((resolve) => {
      resolveStatuses = resolve;
    }));
    setSystemTime(100);
    const input = createSyncInput();
    ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, sessionId);
    await waitForSubscriptions(1);
    await flushMicrotasks();

    setSystemTime(200);
    applyStatus(input, { type: "busy" });
    setSystemTime(300);
    applyStatus(input, { type: "idle" });
    resolveStatuses({ [sessionId]: { type: "busy" } });
    await flushMicrotasks();

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive).toBe(false);
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "idle" });

    releaseSession();
  });

  test("heals an active record when a reconnect reports no active run", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({}));
    setSystemTime(100);
    const input = createSyncInput();
    ensureWorkspaceSessionSync(input);
    await waitForSubscriptions(1);
    await flushMicrotasks();

    setSystemTime(200);
    applyStatus(input, { type: "busy" });
    jest.useFakeTimers();
    subscriptions[0]?.end();
    await flushMicrotasks();
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();

    expect(subscriptions).toHaveLength(2);
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.status).toBe("idle");
  });

  test("keeps the stream and run state intact when reconciliation fails", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => {
      throw new Error("status unavailable");
    });
    setSystemTime(100);
    const input = createSyncInput();
    ensureWorkspaceSessionSync(input);
    await waitForSubscriptions(1);
    await flushMicrotasks();

    setSystemTime(200);
    applyStatus(input, { type: "busy" });
    jest.useFakeTimers();
    subscriptions[0]?.end();
    await flushMicrotasks();
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();

    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.signal.aborted).toBe(false);
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive).toBe(true);
  });
});

describe("active session status reconciliation", () => {
  test("converges a missed terminal edge to idle without losing the completed tool or final answer", async () => {
    jest.useFakeTimers();
    setSystemTime(100);
    let statusFetches = 0;
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => {
      statusFetches += 1;
      return {};
    });
    const { input, cleanup, releaseSession } = createTestSync();
    const queryClient = getReactQueryClient();
    queryClient.setQueryData(snapshotKey(workspaceId, sessionId), createSnapshot({ type: "busy" }));

    applyStatus(input, { type: "busy" });
    applyCompletedToolAndFinalAnswer(input);

    const before = queryClient.getQueryData<any[]>(transcriptKey(workspaceId, sessionId));
    expect(before?.[0]?.parts[0]).toMatchObject({
      type: "dynamic-tool",
      state: "output-available",
      output: "fixture result",
    });
    expect(before?.[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "The final answer is visible.",
    });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("responding");

    // No session.status idle or session.idle event arrives. The long-lived
    // stream remains open; only the authoritative status level reports that
    // the run has ended.
    setSystemTime(350);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    expect(statusFetches).toBe(1);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");
    expect(queryClient.getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "idle" });
    expect(queryClient.getQueryState(snapshotKey(workspaceId, sessionId))?.isInvalidated).toBe(true);
    const after = queryClient.getQueryData<any[]>(transcriptKey(workspaceId, sessionId));
    expect(after?.[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "The final answer is visible.",
    });

    releaseSession();
    cleanup();
  });

  test("keeps genuine tool, retry, waiting, and compaction work active until status is authoritatively idle", async () => {
    jest.useFakeTimers();
    setSystemTime(100);
    let status: Record<string, SessionStatus> = { [sessionId]: { type: "busy" } };
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => status);
    const { input, cleanup, releaseSession } = createTestSync();

    applyStatus(input, { type: "busy" });
    useSessionActivityStore.getState().setWaitingRequest(
      workspaceId,
      sessionId,
      "permission",
      "permission-1",
      true,
    );
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("waiting");

    useSessionActivityStore.getState().setWaitingRequest(
      workspaceId,
      sessionId,
      "permission",
      "permission-1",
      false,
    );
    useSessionActivityStore.getState().setCompacting(workspaceId, sessionId, true);
    status = {
      [sessionId]: {
        type: "retry",
        attempt: 1,
        message: "retrying",
        next: 1_000,
      },
    };
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("compacting");
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive).toBe(true);

    status = {};
    jest.advanceTimersByTime(250);
    await flushMicrotasks();
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");

    releaseSession();
    cleanup();
  });

  test("keeps a newer busy edge when an older idle poll resolves after a queued follow-up starts", async () => {
    jest.useFakeTimers();
    setSystemTime(100);
    let resolveStatuses: (statuses: Record<string, SessionStatus>) => void = () => {};
    __setWorkspaceSessionSyncStatusFetcherForTest(() => new Promise((resolve) => {
      resolveStatuses = resolve;
    }));
    const { input, cleanup, releaseSession } = createTestSync();

    applyStatus(input, { type: "busy" });
    setSystemTime(350);
    jest.advanceTimersByTime(250);
    await flushMicrotasks();

    // A queued follow-up starts while the older status request is in flight.
    // Its live edge must win over the stale empty snapshot.
    setSystemTime(Date.now() + 100);
    applyStatus(input, { type: "busy" });
    resolveStatuses({});
    await flushMicrotasks();

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive).toBe(true);
    expect(getReactQueryClient().getQueryData(statusKey(workspaceId, sessionId))).toEqual({ type: "busy" });

    releaseSession();
    cleanup();
  });

  test("accepts terminal-before-close, reordered final content, and duplicate terminal events", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({}));
    setSystemTime(100);
    const input = createSyncInput();
    ensureWorkspaceSessionSync(input);
    const releaseSession = trackWorkspaceSessionSync(input, sessionId);
    await waitForSubscriptions(1);
    await flushMicrotasks();

    applyStatus(input, { type: "busy" });
    setSystemTime(200);
    __applySessionSyncEventForTest(input, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    });

    // The event transport is intentionally still open when terminal status
    // arrives, and final content is delivered after it.
    expect(subscriptions[0]?.signal.aborted).toBe(false);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");
    applyCompletedToolAndFinalAnswer(input);

    // Duplicate modern and deprecated terminal events remain idempotent.
    applyStatus(input, { type: "idle" });
    __applySessionSyncEventForTest(input, {
      type: "session.idle",
      properties: { sessionID: sessionId },
    });

    const transcript = getReactQueryClient().getQueryData<any[]>(transcriptKey(workspaceId, sessionId));
    expect(transcript?.[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "The final answer is visible.",
    });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");
    expect(subscriptions[0]?.signal.aborted).toBe(false);

    releaseSession();
  });
});
