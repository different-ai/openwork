export type ConnectPolicyDesired = {
  connectEnabled: boolean;
  revision: string;
};

export type ConnectPolicyTarget = {
  key: string;
  apply: (connectEnabled: boolean) => Promise<void>;
};

export type ConnectPolicySyncState =
  | { state: "idle" }
  | { state: "pending"; reason: "runtime_unavailable" | "applying" | "retrying" }
  | { state: "applied" }
  | { state: "stalled"; reason: "runtime_unavailable" | "apply_failed" };

export type ConnectPolicyReconcilerDeps = {
  resolveTarget: () => Promise<ConnectPolicyTarget | null>;
  wait: (delayMs: number) => Promise<void>;
  onStateChange?: (state: ConnectPolicySyncState) => void;
};

export type ConnectPolicyReconciler = {
  setDesired: (desired: ConnectPolicyDesired | null) => void;
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
          if (isStale(runEpoch)) return;
          await target.apply(currentDesired.connectEnabled);
        });
        applyChain = attempt.catch(() => undefined);
        await attempt;
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
