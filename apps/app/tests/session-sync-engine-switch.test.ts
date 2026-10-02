import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import {
  __createWorkspaceSessionSyncForTest,
  __disposeWorkspaceSessionSyncForTest,
  __hasWorkspaceSessionSyncForTest,
  __resetWorkspaceSyncReconcileHealthForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __setWorkspaceSessionSyncSubscriptionFactoryForTest,
  activeSessionStatusReconcileDelayMs,
  ensureWorkspaceSessionSync,
  reconcileFailureDegradedThreshold,
  revalidateWorkspaceSessionSync,
  seedSessionStatus,
  snapshotKey,
  trackWorkspaceSessionSync,
  useWorkspaceSyncStreamStore,
} from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

type SyncInput = { workspaceId: string; baseUrl: string; openworkToken: string };

const workspaceId = "workspace-engine-switch";
const v1Session = "ses_v1_task";
const v2Session = "ses_v2_task";
const inputs: SyncInput[] = [];
const subscriptions: Array<{ signal: AbortSignal; end: () => void }> = [];

function syncInput(engine: "v1" | "v2", label = "engine-switch"): SyncInput {
  const input = {
    workspaceId,
    baseUrl: `https://${label}.example/workspace/ws/${engine === "v2" ? "opencode2" : "opencode"}`,
    openworkToken: "token",
  };
  inputs.push(input);
  return input;
}

async function createSubscription(_baseUrl: string, _token: string, signal: AbortSignal) {
  let end = () => {};
  const ended = new Promise<void>((resolve) => { end = resolve; });
  signal.addEventListener("abort", end, { once: true });
  subscriptions.push({ signal, end });
  async function* stream() { await ended; }
  return stream();
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

/** One fake engine per lane: each only reports the runs it owns. */
function engines(statuses: { v1: Record<string, SessionStatus>; v2: Record<string, SessionStatus> }) {
  const calls = { v1: 0, v2: 0 };
  __setWorkspaceSessionSyncStatusFetcherForTest(async (baseUrl) => {
    const engine = baseUrl.endsWith("/opencode2") ? "v2" : "v1";
    calls[engine] += 1;
    return statuses[engine];
  });
  return calls;
}

function record(sessionId: string) {
  return useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId];
}

afterEach(() => {
  jest.useRealTimers();
  for (const input of inputs) __disposeWorkspaceSessionSyncForTest(input);
  inputs.length = 0;
  subscriptions.length = 0;
  __setWorkspaceSessionSyncSubscriptionFactoryForTest(null);
  __setWorkspaceSessionSyncStatusFetcherForTest(null);
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  useWorkspaceSyncStreamStore.setState({ phasesByKey: {} });
  __resetWorkspaceSyncReconcileHealthForTest();
  getReactQueryClient().clear();
  setSystemTime();
});

describe("session sync across an engine switch", () => {
  test("a v2 transcript read does not make the v1 sync settle and reload the running chat", async () => {
    jest.useFakeTimers();
    setSystemTime(1_000);
    const calls = engines({ v1: {}, v2: { [v2Session]: { type: "busy" } } });
    const v1 = syncInput("v1");
    const v2 = syncInput("v2");
    __createWorkspaceSessionSyncForTest(v1);
    __createWorkspaceSessionSyncForTest(v2);
    trackWorkspaceSessionSync(v1, v2Session);
    trackWorkspaceSessionSync(v2, v2Session);
    const queryClient = getReactQueryClient();
    queryClient.setQueryData(snapshotKey(workspaceId, v2Session), { session: { id: v2Session }, messages: [] });

    seedSessionStatus(workspaceId, v2Session, { type: "busy" }, { snapshotStartedAt: Date.now(), engine: "v2" });
    for (let tick = 0; tick < 8; tick += 1) {
      jest.advanceTimersByTime(250);
      await flushMicrotasks();
    }

    // Before the fix the v1 sync adopted the run, its read (which cannot list
    // a v2 chat) settled it idle and invalidated the transcript on every poll.
    expect(calls.v1).toBe(0);
    expect(calls.v2).toBeGreaterThan(0);
    expect(record(v2Session)?.runActive).toBe(true);
    expect(queryClient.getQueryState(snapshotKey(workspaceId, v2Session))?.isInvalidated).toBe(false);
  });

  test("switching chats to the other engine stops the released engine's polling at once", async () => {
    jest.useFakeTimers();
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const calls = engines({ v1: { [v1Session]: { type: "busy" } }, v2: {} });
    const v1 = syncInput("v1");
    const releaseV1 = ensureWorkspaceSessionSync(v1);
    const releaseV1Session = trackWorkspaceSessionSync(v1, v1Session);
    await flushMicrotasks();
    expect(record(v1Session)?.runActive).toBe(true);

    // The route swaps its runtime from v1 to v2: release, then ensure.
    releaseV1Session();
    releaseV1();
    expect(__hasWorkspaceSessionSyncForTest(v1)).toBe(true);
    const v2 = syncInput("v2");
    const releaseV2 = ensureWorkspaceSessionSync(v2);

    expect(__hasWorkspaceSessionSyncForTest(v1)).toBe(false);
    expect(subscriptions[0]?.signal.aborted).toBe(true);
    const v1Reads = calls.v1;
    for (let tick = 0; tick < 40; tick += 1) {
      jest.advanceTimersByTime(250);
      await flushMicrotasks();
    }
    expect(calls.v1).toBe(v1Reads);
    releaseV2();
  });

  test("a sync that keeps a v1 owner does not settle v2 chats when it reconnects", async () => {
    setSystemTime(1_000);
    engines({ v1: {}, v2: { [v2Session]: { type: "busy" } } });
    const v1 = syncInput("v1");
    const v2 = syncInput("v2");
    __createWorkspaceSessionSyncForTest(v1);
    __createWorkspaceSessionSyncForTest(v2);
    trackWorkspaceSessionSync(v1, v1Session);
    trackWorkspaceSessionSync(v2, v2Session);
    useSessionActivityStore.getState().seedSessionRun(workspaceId, v1Session, { type: "busy" }, undefined, { snapshotStartedAt: 1_000 });
    useSessionActivityStore.getState().seedSessionRun(workspaceId, v2Session, { type: "busy" }, undefined, { snapshotStartedAt: 1_000 });

    setSystemTime(2_000);
    await revalidateWorkspaceSessionSync(v1);

    expect(record(v1Session)?.runActive).toBe(false);
    expect(record(v2Session)?.runActive).toBe(true);
  });
});

describe("active status polling backoff", () => {
  test("keeps the fast cadence through a blip, then backs off to a bounded interval", () => {
    expect(activeSessionStatusReconcileDelayMs(0)).toBe(250);
    expect(activeSessionStatusReconcileDelayMs(reconcileFailureDegradedThreshold - 1)).toBe(250);
    expect(activeSessionStatusReconcileDelayMs(reconcileFailureDegradedThreshold)).toBe(1_000);
    expect(activeSessionStatusReconcileDelayMs(reconcileFailureDegradedThreshold + 2)).toBe(4_000);
    expect(activeSessionStatusReconcileDelayMs(99)).toBe(15_000);
  });

  test("an engine that stopped answering is not polled at 4 Hz, and a recovered one is again", async () => {
    jest.useFakeTimers();
    setSystemTime(1_000);
    let reachable = false;
    let reads = 0;
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => {
      reads += 1;
      if (!reachable) throw Object.assign(new Error("engine_v2_preview_not_running"), { status: 503 });
      return { [v2Session]: { type: "busy" } };
    });
    const v2 = syncInput("v2", "backoff");
    __createWorkspaceSessionSyncForTest(v2);
    trackWorkspaceSessionSync(v2, v2Session);
    seedSessionStatus(workspaceId, v2Session, { type: "busy" }, { snapshotStartedAt: Date.now(), engine: "v2" });

    for (let elapsed = 0; elapsed < 60_000; elapsed += 250) {
      jest.advanceTimersByTime(250);
      await flushMicrotasks();
    }
    // 4 Hz would be 240 reads in a minute.
    expect(reads).toBeLessThan(15);
    expect(record(v2Session)?.runActive).toBe(true);

    reachable = true;
    jest.advanceTimersByTime(15_000);
    await flushMicrotasks();
    const recoveredAt = reads;
    for (let tick = 0; tick < 4; tick += 1) {
      jest.advanceTimersByTime(250);
      await flushMicrotasks();
    }
    expect(reads - recoveredAt).toBe(4);
  });
});
