import { afterEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { SessionStatus } from "@opencode-ai/sdk/v2/client";

import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import {
  __disposeWorkspaceSessionSyncForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __setWorkspaceSessionSyncSubscriptionFactoryForTest,
  ensureWorkspaceSessionSync,
  getWorkspaceSessionSyncStreamPhase,
  statusKey,
  trackWorkspaceSessionSync,
  transcriptKey,
  useWorkspaceSyncStreamStore,
} from "../src/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

type SyncInput = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
};

type LiveSubscription = {
  token: string;
  push: (event: unknown) => void;
  signal: AbortSignal;
};

const workspaceId = "workspace-token-rotation";
const sessionId = "session-token-rotation";
const baseUrl = "https://token-rotation.example/opencode";
const staleToken = "stale-token";
const freshToken = "fresh-token";

const syncInputs: SyncInput[] = [];
const liveSubscriptions: LiveSubscription[] = [];
let authRejections = 0;

function createSyncInput(openworkToken: string): SyncInput {
  const input = { workspaceId, baseUrl, openworkToken };
  syncInputs.push(input);
  return input;
}

async function subscriptionFactory(_baseUrl: string, token: string, signal: AbortSignal) {
  if (token === staleToken) {
    authRejections += 1;
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let ended = false;
  const wake = () => {
    const pending = notify;
    notify = null;
    pending?.();
  };
  const push = (event: unknown) => {
    queue.push(event);
    wake();
  };
  signal.addEventListener("abort", () => {
    ended = true;
    wake();
  }, { once: true });
  async function* stream() {
    while (!ended) {
      while (queue.length > 0) yield queue.shift();
      if (ended) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }
  liveSubscriptions.push({ token, push, signal });
  return stream();
}

async function eventually(check: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (!check()) throw new Error(`Timed out waiting for: ${label}`);
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  for (const input of syncInputs) __disposeWorkspaceSessionSyncForTest(input);
  syncInputs.length = 0;
  liveSubscriptions.length = 0;
  authRejections = 0;
  __setWorkspaceSessionSyncSubscriptionFactoryForTest(null);
  __setWorkspaceSessionSyncStatusFetcherForTest(null);
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  useWorkspaceSyncStreamStore.setState({ phasesByKey: {} });
  getReactQueryClient().clear();
});

describe("session sync token rotation", () => {
  test("a rotated token restarts an auth-blocked stream without a remount and the task resumes", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(subscriptionFactory);
    // The server still reports the long task busy: reconciliation on the
    // reconnect must override any idle recorded while the stream was down.
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({
      [sessionId]: { type: "busy" } satisfies SessionStatus,
    }));

    const staleInput = createSyncInput(staleToken);
    const releaseWorkspace = ensureWorkspaceSessionSync(staleInput);
    const releaseSession = trackWorkspaceSessionSync(staleInput, sessionId);

    // The stale token breaks the stream: it parks visibly in the
    // authentication-blocked state instead of dying silently.
    await eventually(() => authRejections >= 1, "stale token rejected");
    await flushMicrotasks();
    expect(getWorkspaceSessionSyncStreamPhase(staleInput)).toBe("auth-blocked");
    expect(liveSubscriptions).toHaveLength(0);

    // While the stream is down the client cached an idle status.
    getReactQueryClient().setQueryData(statusKey(workspaceId, sessionId), { type: "idle" });

    // Reattachment rotates the token on the same sync entry — no remount,
    // no release of the original owner.
    const freshInput = createSyncInput(freshToken);
    const releaseRotated = ensureWorkspaceSessionSync(freshInput);

    await eventually(() => liveSubscriptions.length === 1, "fresh token subscribed");
    expect(liveSubscriptions[0]?.token).toBe(freshToken);
    await eventually(
      () => getWorkspaceSessionSyncStreamPhase(freshInput) === "live",
      "stream live after rotation",
    );

    // Level reconciliation corrected the cached idle to the server's busy
    // truth before the stream is trusted again.
    await eventually(
      () => {
        const cached = getReactQueryClient().getQueryData<SessionStatus>(statusKey(workspaceId, sessionId));
        return cached?.type === "busy";
      },
      "cached idle reconciled to busy",
    );
    expect(
      useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.[sessionId]?.runActive,
    ).toBe(true);

    // The same task's output resumes over the restarted stream…
    liveSubscriptions[0]?.push({
      type: "message.updated",
      properties: { info: { id: "assistant-resumed", sessionID: sessionId, role: "assistant" } },
    });
    await eventually(
      () => {
        const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId));
        return Boolean(transcript?.some((message) => message.id === "assistant-resumed"));
      },
      "resumed assistant message reached the transcript",
    );

    // …and completes.
    liveSubscriptions[0]?.push({ type: "session.idle", properties: { sessionID: sessionId } });
    await eventually(
      () => {
        const cached = getReactQueryClient().getQueryData<SessionStatus>(statusKey(workspaceId, sessionId));
        return cached?.type === "idle";
      },
      "task completed after resume",
    );

    // Negative half: rotation reused the existing entry — exactly one live
    // subscription exists and the stale token never connected.
    expect(liveSubscriptions).toHaveLength(1);
    expect(liveSubscriptions.every((subscription) => subscription.token === freshToken)).toBe(true);

    releaseRotated();
    releaseSession();
    releaseWorkspace();
  });

  test("an unchanged token on reattachment does not churn a healthy stream", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(subscriptionFactory);
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({}));

    const first = createSyncInput(freshToken);
    const releaseFirst = ensureWorkspaceSessionSync(first);
    await eventually(() => liveSubscriptions.length === 1, "initial subscription");

    const second = createSyncInput(freshToken);
    const releaseSecond = ensureWorkspaceSessionSync(second);
    await flushMicrotasks();

    expect(liveSubscriptions).toHaveLength(1);
    expect(liveSubscriptions[0]?.signal.aborted).toBe(false);
    expect(getWorkspaceSessionSyncStreamPhase(first)).toBe("live");

    releaseSecond();
    releaseFirst();
  });
});
