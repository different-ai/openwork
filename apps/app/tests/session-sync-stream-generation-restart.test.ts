import { expect, jest, test } from "bun:test";

import {
  startSyncStreamLifecycle,
  type SyncStreamPhase,
} from "../src/react-app/domains/session/sync/sync-stream-lifecycle";

function authError(status: number) {
  return Object.assign(new Error(`subscribe rejected with ${status}`), { status });
}

function isAuthError(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return false;
  const status = error.status;
  return status === 401 || status === 403 || status === 404;
}

function streamOf(items: unknown[], options: { thenHang: boolean }, signal: AbortSignal): AsyncIterable<unknown> {
  return (async function* () {
    for (const item of items) yield item;
    if (options.thenHang) {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  })();
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function advanceTimersByTime(ms: number) {
  await flushMicrotasks();
  if (ms === 0) return;
  let remaining = ms;
  while (remaining > 0) {
    const step = Math.min(1_000, remaining);
    jest.advanceTimersByTime(step);
    await flushMicrotasks();
    remaining -= step;
  }
}

test("a stale-token stream restarts on generation change and resumes events", async () => {
  jest.useFakeTimers();
  try {
    let token = "generation-1";
    const received: string[] = [];
    const phases: SyncStreamPhase[] = [];
    const timeline: string[] = [];
    let subscribeAttempts = 0;

    const lifecycle = startSyncStreamLifecycle({
      subscribe: async (signal) => {
        subscribeAttempts += 1;
        timeline.push(`subscribe:${subscribeAttempts}:${token}`);
        if (subscribeAttempts === 1) {
          return streamOf(["task-started", "output-1"], { thenHang: false }, signal);
        }
        if (token !== "generation-2") throw authError(401);
        return streamOf(["output-2", "task-completed"], { thenHang: true }, signal);
      },
      onEvent: (event) => {
        received.push(String(event));
        timeline.push(`event:${String(event)}`);
      },
      onConnected: () => {
        timeline.push("reconcile");
      },
      onPhaseChange: (phase) => phases.push(phase),
      isAuthError,
    });

    await advanceTimersByTime(0);
    expect(received).toEqual(["task-started", "output-1"]);
    expect(lifecycle.getPhase()).toBe("reconnecting");

    await advanceTimersByTime(1_000);
    expect(subscribeAttempts).toBe(2);
    expect(lifecycle.getPhase()).toBe("auth-blocked");
    await advanceTimersByTime(5_000);
    expect(subscribeAttempts).toBe(3);
    expect(lifecycle.getPhase()).toBe("auth-blocked");
    expect(received).toEqual(["task-started", "output-1"]);

    token = "generation-2";
    lifecycle.notifyGenerationChanged();
    expect(subscribeAttempts).toBe(4);
    await advanceTimersByTime(0);

    expect(received).toEqual(["task-started", "output-1", "output-2", "task-completed"]);
    expect(lifecycle.getPhase()).toBe("live");
    const reconnectSubscribe = timeline.indexOf("subscribe:4:generation-2");
    const reconnectReconcile = timeline.indexOf("reconcile", reconnectSubscribe);
    const resumedEvent = timeline.indexOf("event:output-2");
    expect(reconnectReconcile).toBeGreaterThan(reconnectSubscribe);
    expect(resumedEvent).toBeGreaterThan(reconnectReconcile);
    expect(phases).toEqual([
      "connecting",
      "live",
      "reconnecting",
      "connecting",
      "auth-blocked",
      "connecting",
      "auth-blocked",
      "connecting",
      "live",
    ]);

    lifecycle.dispose();
  } finally {
    jest.useRealTimers();
  }
});

test("a permanently invalid token retries with bounded exponential backoff", async () => {
  jest.useFakeTimers();
  try {
    const attemptAt: number[] = [];
    const lifecycle = startSyncStreamLifecycle({
      subscribe: async () => {
        attemptAt.push(Date.now());
        throw authError(403);
      },
      onEvent: () => {},
      isAuthError,
    });

    await advanceTimersByTime(10 * 60_000);

    expect(lifecycle.getPhase()).toBe("auth-blocked");
    expect(attemptAt.length).toBeGreaterThanOrEqual(5);
    expect(attemptAt.length).toBeLessThanOrEqual(15);
    const gaps = attemptAt.slice(1).map((at, index) => at - attemptAt[index]);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(5_000);
      expect(gap).toBeLessThanOrEqual(60_000);
    }
    expect(gaps.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(gaps.at(-1)).toBe(60_000);

    lifecycle.dispose();
  } finally {
    jest.useRealTimers();
  }
});

test("a silent live stream is exposed as stale and reconnected by the watchdog", async () => {
  jest.useFakeTimers();
  try {
    let attempts = 0;
    const phases: SyncStreamPhase[] = [];
    const lifecycle = startSyncStreamLifecycle({
      subscribe: async (signal) => {
        attempts += 1;
        return streamOf([], { thenHang: true }, signal);
      },
      onEvent: () => {},
      onPhaseChange: (phase) => phases.push(phase),
      isAuthError,
    });

    await advanceTimersByTime(0);
    expect(lifecycle.getPhase()).toBe("live");

    await advanceTimersByTime(40_000);
    expect(phases).toContain("stale");
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(lifecycle.getPhase()).toBe("live");

    lifecycle.dispose();
  } finally {
    jest.useRealTimers();
  }
});
