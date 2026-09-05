import { describe, expect, test } from "bun:test";

import {
  CONNECT_POLICY_BACKOFF_SCHEDULE_MS,
  createConnectPolicyReconciler,
  type ConnectPolicySyncState,
  type ConnectPolicyTarget,
} from "../src/react-app/domains/cloud/connect-policy-reconciler";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async (turns = 8) => {
  for (let index = 0; index < turns; index += 1) await tick();
};

type PendingWait = { delayMs: number; release: () => void };

function createHarness() {
  const applyCalls: { key: string; value: boolean }[] = [];
  const waits: PendingWait[] = [];
  const states: ConnectPolicySyncState[] = [];
  let resolveTargetImpl: () => Promise<ConnectPolicyTarget | null> = async () => null;

  const makeTarget = (
    key: string,
    options?: { applyGate?: () => Promise<void>; failApply?: () => boolean },
  ): ConnectPolicyTarget => ({
    key,
    apply: async (value) => {
      await options?.applyGate?.();
      if (options?.failApply?.()) throw new Error("transient apply failure");
      applyCalls.push({ key, value });
    },
  });

  const reconciler = createConnectPolicyReconciler({
    resolveTarget: () => resolveTargetImpl(),
    wait: (delayMs) =>
      new Promise<void>((resolve) => {
        waits.push({ delayMs, release: resolve });
      }),
    onStateChange: (state) => {
      states.push(state);
    },
  });

  return {
    reconciler,
    applyCalls,
    waits,
    states,
    makeTarget,
    setTarget: (impl: () => Promise<ConnectPolicyTarget | null>) => {
      resolveTargetImpl = impl;
    },
    releaseNextWait: async () => {
      const next = waits.shift();
      expect(next).toBeDefined();
      next?.release();
      await settle();
    },
  };
}

describe("Connect policy reconciler", () => {
  test("applies immediately when the runtime is ready before the policy arrives", async () => {
    const harness = createHarness();
    const target = harness.makeTarget("gen-a");
    harness.setTarget(async () => target);

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();

    expect(harness.applyCalls).toEqual([{ key: "gen-a", value: true }]);
    expect(harness.waits).toHaveLength(0);
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
    expect(harness.reconciler.getLastApplied()).toEqual({
      targetKey: "gen-a",
      connectEnabled: true,
      revision: "org-1",
    });
  });

  test("converges when the runtime becomes ready only after the bounded backoff parked it", async () => {
    const harness = createHarness();
    harness.setTarget(async () => null);

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();

    // Advance every fake backoff delay: the runtime never becomes ready, so
    // the epoch exhausts the bounded schedule and parks in a sanitized state
    // instead of looping forever.
    const observedDelays: number[] = [];
    for (let index = 0; index < CONNECT_POLICY_BACKOFF_SCHEDULE_MS.length; index += 1) {
      const next = harness.waits[0];
      expect(next).toBeDefined();
      if (next) observedDelays.push(next.delayMs);
      await harness.releaseNextWait();
    }
    expect(observedDelays).toEqual([...CONNECT_POLICY_BACKOFF_SCHEDULE_MS]);
    expect(harness.applyCalls).toHaveLength(0);
    expect(harness.reconciler.getState()).toEqual({ state: "stalled", reason: "runtime_unavailable" });
    expect(harness.waits).toHaveLength(0);

    // The runtime publishing its connection is observed as a target change
    // and converges the policy — however late readiness arrived.
    const target = harness.makeTarget("gen-late");
    harness.setTarget(async () => target);
    harness.reconciler.notifyTargetChanged();
    await settle();

    expect(harness.applyCalls).toEqual([{ key: "gen-late", value: true }]);
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("reapplies an unchanged policy to a new runtime generation after a restart", async () => {
    const harness = createHarness();
    harness.setTarget(async () => harness.makeTarget("gen-a"));
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    expect(harness.applyCalls).toEqual([{ key: "gen-a", value: true }]);

    // Restart: same desired policy, new generation.
    harness.setTarget(async () => harness.makeTarget("gen-b"));
    harness.reconciler.notifyTargetChanged();
    await settle();

    expect(harness.applyCalls).toEqual([
      { key: "gen-a", value: true },
      { key: "gen-b", value: true },
    ]);
    expect(harness.reconciler.getLastApplied()).toEqual({
      targetKey: "gen-b",
      connectEnabled: true,
      revision: "org-1",
    });
  });

  test("converges both policy directions over the previously applied value", async () => {
    const harness = createHarness();
    harness.setTarget(async () => harness.makeTarget("gen-a"));

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    harness.reconciler.setDesired({ connectEnabled: false, revision: "org-1" });
    await settle();
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();

    expect(harness.applyCalls).toEqual([
      { key: "gen-a", value: true },
      { key: "gen-a", value: false },
      { key: "gen-a", value: true },
    ]);
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("reasserts the policy when the organization changes even if the switch value is unchanged", async () => {
    const harness = createHarness();
    harness.setTarget(async () => harness.makeTarget("gen-a"));

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-2" });
    await settle();

    expect(harness.applyCalls).toEqual([
      { key: "gen-a", value: true },
      { key: "gen-a", value: true },
    ]);
    expect(harness.reconciler.getLastApplied()).toEqual({
      targetKey: "gen-a",
      connectEnabled: true,
      revision: "org-2",
    });
  });

  test("a late result from an obsolete generation is discarded and never recorded", async () => {
    const harness = createHarness();
    let releaseStaleApply: () => void = () => {};
    const staleGate = new Promise<void>((resolve) => {
      releaseStaleApply = resolve;
    });
    harness.setTarget(async () => harness.makeTarget("gen-old", { applyGate: () => staleGate }));

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    // The apply against gen-old is in flight and blocked.
    expect(harness.reconciler.getState()).toEqual({ state: "pending", reason: "applying" });

    // Workspace switch / restart: the target moves to a new generation while
    // the old attempt is still in flight.
    harness.setTarget(async () => harness.makeTarget("gen-new"));
    harness.reconciler.notifyTargetChanged();
    await settle();

    releaseStaleApply();
    await settle();

    // The stale completion is ignored: the recorded tuple belongs to the new
    // generation and the final state is converged against it.
    expect(harness.applyCalls).toEqual([
      { key: "gen-old", value: true },
      { key: "gen-new", value: true },
    ]);
    expect(harness.reconciler.getLastApplied()).toEqual({
      targetKey: "gen-new",
      connectEnabled: true,
      revision: "org-1",
    });
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("a stale queued attempt abandons its request instead of racing a newer one", async () => {
    const harness = createHarness();
    let releaseFirstApply: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirstApply = resolve;
    });
    let gateFirst = true;
    harness.setTarget(async () =>
      harness.makeTarget("gen-a", {
        applyGate: () => {
          if (gateFirst) {
            gateFirst = false;
            return firstGate;
          }
          return Promise.resolve();
        },
      }),
    );

    // Epoch 1 applies and blocks while holding the request lock.
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-a" });
    await settle();

    // Epoch 2 queues behind the lock, then epoch 3 makes it stale before it
    // ever issues its request.
    harness.reconciler.setDesired({ connectEnabled: false, revision: "org-b" });
    await settle();
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-c" });
    await settle();

    releaseFirstApply();
    await settle();

    // Three epochs, but only two requests: the stale middle attempt was
    // abandoned inside the lock, so an obsolete value can never land after
    // the newest one.
    expect(harness.applyCalls).toEqual([
      { key: "gen-a", value: true },
      { key: "gen-a", value: true },
    ]);
    expect(harness.reconciler.getLastApplied()).toEqual({
      targetKey: "gen-a",
      connectEnabled: true,
      revision: "org-c",
    });
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("retries transient apply failures with bounded backoff and converges", async () => {
    const harness = createHarness();
    let remainingFailures = 2;
    harness.setTarget(async () =>
      harness.makeTarget("gen-a", {
        failApply: () => {
          if (remainingFailures > 0) {
            remainingFailures -= 1;
            return true;
          }
          return false;
        },
      }),
    );

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();

    expect(harness.waits.map((wait) => wait.delayMs)).toEqual([CONNECT_POLICY_BACKOFF_SCHEDULE_MS[0]]);
    await harness.releaseNextWait();
    expect(harness.waits.map((wait) => wait.delayMs)).toEqual([CONNECT_POLICY_BACKOFF_SCHEDULE_MS[1]]);
    await harness.releaseNextWait();

    expect(harness.applyCalls).toEqual([{ key: "gen-a", value: true }]);
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("permanent failure parks in a sanitized recoverable state and recovers on the next observation", async () => {
    const harness = createHarness();
    let healthy = false;
    let attempts = 0;
    harness.setTarget(async () =>
      harness.makeTarget("gen-a", {
        failApply: () => {
          if (healthy) return false;
          attempts += 1;
          return true;
        },
      }),
    );

    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    for (let index = 0; index < CONNECT_POLICY_BACKOFF_SCHEDULE_MS.length; index += 1) {
      await harness.releaseNextWait();
    }

    expect(attempts).toBe(CONNECT_POLICY_BACKOFF_SCHEDULE_MS.length + 1);
    // The parked state carries only a sanitized reason — no error text,
    // URLs, or tokens.
    expect(harness.reconciler.getState()).toEqual({ state: "stalled", reason: "apply_failed" });
    expect(harness.waits).toHaveLength(0);

    healthy = true;
    harness.reconciler.notifyTargetChanged();
    await settle();
    expect(harness.applyCalls).toEqual([{ key: "gen-a", value: true }]);
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("re-observing a converged target is idempotent and issues no requests", async () => {
    const harness = createHarness();
    harness.setTarget(async () => harness.makeTarget("gen-a"));
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    expect(harness.applyCalls).toHaveLength(1);

    harness.reconciler.notifyTargetChanged();
    await settle();
    harness.reconciler.notifyTargetChanged();
    await settle();
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();

    expect(harness.applyCalls).toHaveLength(1);
    expect(harness.waits).toHaveLength(0);
    expect(harness.reconciler.getState()).toEqual({ state: "applied" });
  });

  test("returns to idle when the explicit policy is withdrawn", async () => {
    const harness = createHarness();
    harness.setTarget(async () => harness.makeTarget("gen-a"));
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    harness.reconciler.setDesired(null);
    await settle();

    expect(harness.applyCalls).toHaveLength(1);
    expect(harness.reconciler.getState()).toEqual({ state: "idle" });
  });

  test("dispose invalidates pending work", async () => {
    const harness = createHarness();
    harness.setTarget(async () => null);
    harness.reconciler.setDesired({ connectEnabled: true, revision: "org-1" });
    await settle();
    expect(harness.waits).toHaveLength(1);

    harness.reconciler.dispose();
    harness.setTarget(async () => harness.makeTarget("gen-a"));
    const pending = harness.waits.shift();
    pending?.release();
    await settle();

    expect(harness.applyCalls).toHaveLength(0);
    harness.reconciler.notifyTargetChanged();
    harness.reconciler.setDesired({ connectEnabled: false, revision: "org-2" });
    await settle();
    expect(harness.applyCalls).toHaveLength(0);
  });
});
