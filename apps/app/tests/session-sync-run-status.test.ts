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
  statusKey,
  trackWorkspaceSessionSync,
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
