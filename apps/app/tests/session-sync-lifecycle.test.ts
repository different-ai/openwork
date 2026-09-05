import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";

type SyncInput = {
  workspaceId: string;
  baseUrl: string;
  openworkToken: string;
};

type Subscription = {
  baseUrl: string;
  token: string;
  signal: AbortSignal;
  end: () => void;
};

const subscriptions: Subscription[] = [];

const {
  __applySessionSyncEventForTest,
  __disposeWorkspaceSessionSyncForTest,
  __hasWorkspaceSessionSyncForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __setWorkspaceSessionSyncSubscriptionFactoryForTest,
  ensureWorkspaceSessionSync,
} = await import("../src/react-app/domains/session/sync/session-sync");

const inputs: SyncInput[] = [];
const originalSetInterval = globalThis.setInterval;

function input(baseUrl: string, openworkToken: string): SyncInput {
  const value = { workspaceId: "ws_shared", baseUrl, openworkToken };
  inputs.push(value);
  return value;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function createSubscription(baseUrl: string, token: string, signal: AbortSignal) {
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  signal.addEventListener("abort", end, { once: true });
  async function* stream() {
    await ended;
  }
  subscriptions.push({ baseUrl, token, signal, end });
  return stream();
}

async function waitForSubscriptions(count: number) {
  const deadline = Date.now() + 2_000;
  while (subscriptions.length < count && Date.now() < deadline) {
    await delay(5);
  }
  expect(subscriptions).toHaveLength(count);
}

beforeEach(() => {
  __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({}));
});

afterEach(() => {
  jest.useRealTimers();
  for (const syncInput of inputs) __disposeWorkspaceSessionSyncForTest(syncInput);
  inputs.length = 0;
  subscriptions.length = 0;
  __setWorkspaceSessionSyncSubscriptionFactoryForTest(null);
  __setWorkspaceSessionSyncStatusFetcherForTest(null);
  setSystemTime();
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    writable: true,
    value: originalSetInterval,
  });
});

describe("workspace session sync lifecycle", () => {
  test("keeps a reattached observer after the older attachment releases", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const syncInput = input("https://one.example/opencode", "token");
    const onSessionStatus = jest.fn();
    const observedInput = { ...syncInput, onSessionStatus };

    const releaseFirst = ensureWorkspaceSessionSync(observedInput);
    await waitForSubscriptions(1);
    const releaseSecond = ensureWorkspaceSessionSync(observedInput);
    releaseFirst();

    __applySessionSyncEventForTest(syncInput, {
      type: "session.status",
      properties: { sessionID: "session-active", status: { type: "busy" } },
    });

    expect(onSessionStatus).toHaveBeenCalledWith({
      sessionId: "session-active",
      status: { type: "busy" },
    });
    releaseSecond();
  });

  test("reuses the stream when immediately re-ensured after release", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const syncInput = input("https://one.example/opencode", "token");

    const releaseFirst = ensureWorkspaceSessionSync(syncInput);
    await waitForSubscriptions(1);
    const firstSignal = subscriptions[0]!.signal;
    releaseFirst();
    const releaseSecond = ensureWorkspaceSessionSync(syncInput);

    await delay(20);
    expect(subscriptions).toHaveLength(1);
    expect(firstSignal.aborted).toBe(false);
    releaseSecond();
  });

  test("disposes after the release grace period when nobody re-ensures", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const syncInput = input("https://one.example/opencode", "token");
    const release = ensureWorkspaceSessionSync(syncInput);
    await waitForSubscriptions(1);

    jest.useFakeTimers();
    release();
    jest.advanceTimersByTime(1_999);
    expect(subscriptions[0]!.signal.aborted).toBe(false);
    expect(__hasWorkspaceSessionSyncForTest(syncInput)).toBe(true);

    jest.advanceTimersByTime(1);
    expect(subscriptions[0]!.signal.aborted).toBe(true);
    expect(__hasWorkspaceSessionSyncForTest(syncInput)).toBe(false);
  });

  test("re-ensure cancels pending disposal", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const syncInput = input("https://one.example/opencode", "token");
    const releaseFirst = ensureWorkspaceSessionSync(syncInput);
    await waitForSubscriptions(1);

    jest.useFakeTimers();
    releaseFirst();
    jest.advanceTimersByTime(1_000);
    const releaseSecond = ensureWorkspaceSessionSync(syncInput);
    jest.advanceTimersByTime(2_000);

    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.signal.aborted).toBe(false);
    expect(__hasWorkspaceSessionSyncForTest(syncInput)).toBe(true);
    releaseSecond();
  });

  test("reuses an active stream when only the token changes", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const first = input("https://one.example/opencode", "token-old");
    const second = input("https://one.example/opencode", "token-new");

    const releaseFirst = ensureWorkspaceSessionSync(first);
    await waitForSubscriptions(1);
    const firstSignal = subscriptions[0]!.signal;
    const releaseSecond = ensureWorkspaceSessionSync(second);

    await delay(20);
    expect(subscriptions).toHaveLength(1);
    expect(firstSignal.aborted).toBe(false);

    releaseSecond();
    releaseFirst();
  });

  test("uses the updated token after a stream reconnects", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const first = input("https://one.example/opencode", "token-old");
    const second = input("https://one.example/opencode", "token-new");
    const releaseFirst = ensureWorkspaceSessionSync(first);
    await waitForSubscriptions(1);
    const releaseSecond = ensureWorkspaceSessionSync(second);

    subscriptions[0]!.end();
    await waitForSubscriptions(2);

    expect(subscriptions.map(({ token }) => token)).toEqual(["token-old", "token-new"]);
    releaseSecond();
    releaseFirst();
  });

  test("keeps the same workspace id separate across base URLs", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const first = input("https://one.example/opencode", "token-one");
    const second = input("https://two.example/opencode", "token-two");
    const releaseFirst = ensureWorkspaceSessionSync(first);
    const releaseSecond = ensureWorkspaceSessionSync(second);

    await waitForSubscriptions(2);
    expect(subscriptions.map(({ baseUrl }) => baseUrl).sort()).toEqual([
      "https://one.example/opencode",
      "https://two.example/opencode",
    ]);
    expect(subscriptions.every(({ signal }) => !signal.aborted)).toBe(true);

    releaseSecond();
    releaseFirst();
  });

  test("dispose aborts the active stream and cancels a pending retry", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    const activeInput = input("https://one.example/opencode", "token");
    ensureWorkspaceSessionSync(activeInput);
    await waitForSubscriptions(1);

    __disposeWorkspaceSessionSyncForTest(activeInput);
    expect(subscriptions[0]!.signal.aborted).toBe(true);

    const retryInput = input("https://two.example/opencode", "token");
    ensureWorkspaceSessionSync(retryInput);
    await waitForSubscriptions(2);
    subscriptions[1]!.end();
    await delay(20);

    __disposeWorkspaceSessionSyncForTest(retryInput);
    await delay(1_100);
    expect(subscriptions).toHaveLength(2);
  });

  test("the stale-stream watchdog aborts and retries", async () => {
    __setWorkspaceSessionSyncSubscriptionFactoryForTest(createSubscription);
    Object.defineProperty(globalThis, "setInterval", {
      configurable: true,
      writable: true,
      value: (handler: TimerHandler) => originalSetInterval(handler, 5),
    });
    const syncInput = input("https://one.example/opencode", "token");
    ensureWorkspaceSessionSync(syncInput);
    await waitForSubscriptions(1);

    const firstSignal = subscriptions[0]!.signal;
    setSystemTime(Date.now() + 31_000);
    await delay(20);
    expect(firstSignal.aborted).toBe(true);
    await waitForSubscriptions(2);
  });
});
