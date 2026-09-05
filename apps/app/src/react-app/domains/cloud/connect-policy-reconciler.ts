/**
 * Desired-state reconciler for the organization Connect policy.
 *
 * The Den desktop config carries one desired Connect switch
 * (`connectEnabled`). The local OpenWork server owns the actual state and is
 * a moving target: every (re)start is a new *runtime generation*, and a
 * policy delivered to one generation says nothing about the next one.
 *
 * This module reconciles `actual = desired` per target generation instead of
 * retrying a fixed number of times:
 *
 * - The desired value is one normalized tuple: the Connect switch plus the
 *   revision (active organization) it came from.
 * - The target identity combines the resolved runtime connection (base URL +
 *   host token) with the desktop runtime's per-start generation, so it
 *   changes whenever the runtime restarts or the workspace switches to a
 *   different local server lifetime.
 * - Success is recorded as the tuple (target key, desired value, revision).
 *   A new generation never matches the recorded key, so an unchanged policy
 *   is reapplied after a restart.
 * - Every `setDesired` or `notifyTargetChanged` call starts a new epoch.
 *   In-flight attempts from an older epoch are invalidated: their results are
 *   discarded and never recorded against the current target.
 * - Transient failures retry with bounded backoff while the same target
 *   remains relevant. When the schedule is exhausted the reconciler parks in
 *   a sanitized `stalled` state; the next desired-state or target-generation
 *   observation re-arms it. There is no free-running timer loop.
 *
 * Applying the policy is idempotent (a PUT of the desired switch), so
 * re-reconciling an already-converged target performs one cheap target
 * resolution and no policy request.
 */

export type ConnectPolicyDesired = {
  connectEnabled: boolean;
  /** Identity of the policy source, e.g. the active organization id. */
  revision: string;
};

export type ConnectPolicyTarget = {
  /**
   * Stable identity of one runtime generation: the resolved connection plus
   * the desktop runtime's per-start counter. Changes on every restart even
   * though ports and tokens are sticky.
   */
  key: string;
  apply: (connectEnabled: boolean) => Promise<void>;
};

export type ConnectPolicySyncState =
  | { state: "idle" }
  | { state: "pending"; reason: "runtime_unavailable" | "applying" | "retrying" }
  | { state: "applied" }
  | { state: "stalled"; reason: "runtime_unavailable" | "apply_failed" };

export type ConnectPolicyReconcilerDeps = {
  /** Resolve the current runtime target; null while the runtime is not ready. */
  resolveTarget: () => Promise<ConnectPolicyTarget | null>;
  wait: (delayMs: number) => Promise<void>;
  onStateChange?: (state: ConnectPolicySyncState) => void;
};

export type ConnectPolicyReconciler = {
  /** Replace the desired policy. `null` means no explicit organization policy. */
  setDesired: (desired: ConnectPolicyDesired | null) => void;
  /** Observe a possible runtime readiness or generation change. */
  notifyTargetChanged: () => void;
  getState: () => ConnectPolicySyncState;
  getLastApplied: () => ConnectPolicyLastApplied | null;
  dispose: () => void;
};

export type ConnectPolicyLastApplied = {
  targetKey: string;
  connectEnabled: boolean;
  revision: string;
};

/** Bounded backoff for one epoch; exhaustion parks the reconciler as stalled. */
export const CONNECT_POLICY_BACKOFF_SCHEDULE_MS = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
] as const;

function sameDesired(a: ConnectPolicyDesired | null, b: ConnectPolicyDesired | null): boolean {
  if (a === null || b === null) return a === b;
  return a.connectEnabled === b.connectEnabled && a.revision === b.revision;
}

export function createConnectPolicyReconciler(
  deps: ConnectPolicyReconcilerDeps,
): ConnectPolicyReconciler {
  let epoch = 0;
  let disposed = false;
  let desired: ConnectPolicyDesired | null = null;
  let lastApplied: ConnectPolicyLastApplied | null = null;
  let state: ConnectPolicySyncState = { state: "idle" };
  // Serializes policy requests so a stale attempt can never land on the
  // server after a newer one: each attempt re-checks its epoch inside the
  // lock and abandons the request instead of racing it.
  let applyChain: Promise<void> = Promise.resolve();

  const setState = (next: ConnectPolicySyncState) => {
    if (state.state === next.state && ("reason" in state ? state.reason : null) === ("reason" in next ? next.reason : null)) return;
    state = next;
    deps.onStateChange?.(next);
  };

  const isStale = (runEpoch: number) => disposed || runEpoch !== epoch;

  const reconcile = async (runEpoch: number): Promise<void> => {
    for (let failures = 0; ; ) {
      if (isStale(runEpoch)) return;
      const currentDesired = desired;
      if (currentDesired === null) {
        setState({ state: "idle" });
        return;
      }

      let target: ConnectPolicyTarget | null = null;
      try {
        target = await deps.resolveTarget();
      } catch {
        target = null;
      }
      if (isStale(runEpoch)) return;

      if (target === null) {
        const delayMs = CONNECT_POLICY_BACKOFF_SCHEDULE_MS[failures];
        failures += 1;
        if (delayMs === undefined) {
          // The runtime never became ready within this epoch. Park with a
          // sanitized reason; the runtime publishing a connection fires
          // notifyTargetChanged and starts a fresh epoch.
          setState({ state: "stalled", reason: "runtime_unavailable" });
          return;
        }
        setState({ state: "pending", reason: "runtime_unavailable" });
        await deps.wait(delayMs);
        continue;
      }

      if (
        lastApplied !== null &&
        lastApplied.targetKey === target.key &&
        lastApplied.connectEnabled === currentDesired.connectEnabled &&
        lastApplied.revision === currentDesired.revision
      ) {
        setState({ state: "applied" });
        return;
      }

      setState({ state: "pending", reason: "applying" });
      try {
        const attempt = applyChain.then(async () => {
          // Re-check inside the lock: a newer epoch may have applied while
          // this attempt waited its turn, and a stale request must be
          // abandoned rather than raced against the newer one.
          if (isStale(runEpoch)) return;
          await target.apply(currentDesired.connectEnabled);
        });
        applyChain = attempt.catch(() => undefined);
        await attempt;
        // A stale attempt must never record success against the current
        // target: the runtime generation or desired policy moved on while the
        // request was in flight.
        if (isStale(runEpoch)) return;
        lastApplied = {
          targetKey: target.key,
          connectEnabled: currentDesired.connectEnabled,
          revision: currentDesired.revision,
        };
        setState({ state: "applied" });
        return;
      } catch {
        if (isStale(runEpoch)) return;
        const delayMs = CONNECT_POLICY_BACKOFF_SCHEDULE_MS[failures];
        failures += 1;
        if (delayMs === undefined) {
          setState({ state: "stalled", reason: "apply_failed" });
          return;
        }
        setState({ state: "pending", reason: "retrying" });
        await deps.wait(delayMs);
      }
    }
  };

  const startEpoch = () => {
    if (disposed) return;
    epoch += 1;
    void reconcile(epoch);
  };

  return {
    setDesired: (next) => {
      if (disposed) return;
      if (sameDesired(desired, next)) {
        // An unchanged desired value is not a new fact, but it may recover a
        // parked epoch (e.g. the hourly config refresh after a stall).
        if (state.state === "stalled") startEpoch();
        return;
      }
      desired = next;
      startEpoch();
    },
    notifyTargetChanged: () => {
      if (disposed) return;
      startEpoch();
    },
    getState: () => state,
    getLastApplied: () => lastApplied,
    dispose: () => {
      disposed = true;
      epoch += 1;
    },
  };
}
