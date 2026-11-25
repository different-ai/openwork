import { connectionDiagnosticHistory, type ConnectionDiagnosticReason } from "../../../../app/lib/connection-diagnostic-history";

export type SyncStreamPhase =
  | "connecting"
  | "live"
  | "reconnecting"
  | "auth-blocked"
  | "stale";

const phaseDiagnosticReasons: Record<SyncStreamPhase, ConnectionDiagnosticReason> = {
  connecting: "engine_connecting",
  live: "engine_live",
  reconnecting: "engine_reconnecting",
  "auth-blocked": "engine_auth_blocked",
  stale: "engine_stale",
};

type SyncStreamLifecycleOptions = {
  subscribe: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
  onEvent: (event: unknown) => void;
  onConnected?: (signal: AbortSignal) => void;
  onPhaseChange?: (phase: SyncStreamPhase) => void;
  isAuthError?: (error: unknown) => boolean;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  authRetryInitialDelayMs?: number;
  authRetryMaxDelayMs?: number;
  staleStreamMs?: number;
  watchdogIntervalMs?: number;
};

export type SyncStreamLifecycle = {
  notifyGenerationChanged: () => void;
  getPhase: () => SyncStreamPhase;
  dispose: () => void;
};

export function startSyncStreamLifecycle(options: SyncStreamLifecycleOptions): SyncStreamLifecycle {
  const retryInitialDelayMs = options.retryInitialDelayMs ?? 1_000;
  const retryMaxDelayMs = options.retryMaxDelayMs ?? 10_000;
  const authRetryInitialDelayMs = options.authRetryInitialDelayMs ?? 5_000;
  const authRetryMaxDelayMs = options.authRetryMaxDelayMs ?? 60_000;
  const staleStreamMs = options.staleStreamMs ?? 30_000;
  const watchdogIntervalMs = options.watchdogIntervalMs ?? 10_000;
  const isAuthError = options.isAuthError ?? (() => false);

  const diagnostics = connectionDiagnosticHistory.createSource();
  diagnostics.transition("engine_connecting");
  const controller = new AbortController();
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let activeConnectionController: AbortController | null = null;
  let lastEventAt = Date.now();
  let retryDelayMs = retryInitialDelayMs;
  let authRetryDelayMs = authRetryInitialDelayMs;
  let generation = 0;
  let phase: SyncStreamPhase = "connecting";

  const setPhase = (next: SyncStreamPhase) => {
    if (phase === next) return;
    phase = next;
    diagnostics.transition(phaseDiagnosticReasons[next]);
    options.onPhaseChange?.(next);
  };

  const scheduleRetry = (reason: "reconnecting" | "auth-blocked" | "stale") => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    activeConnectionController = null;
    diagnostics.failed();
    setPhase(reason);
    const delayMs = reason === "auth-blocked" ? authRetryDelayMs : retryDelayMs;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, delayMs);
    if (reason === "auth-blocked") {
      authRetryDelayMs = Math.min(authRetryDelayMs * 2, authRetryMaxDelayMs);
    } else {
      retryDelayMs = Math.min(retryDelayMs * 2, retryMaxDelayMs);
    }
  };

  const connect = async () => {
    const connectionController = new AbortController();
    activeConnectionController = connectionController;
    const connectGeneration = generation;
    diagnostics.attempt("engine_retry");
    setPhase("connecting");
    try {
      const stream = await options.subscribe(connectionController.signal);
      retryDelayMs = retryInitialDelayMs;
      authRetryDelayMs = authRetryInitialDelayMs;
      lastEventAt = Date.now();
      diagnostics.recovered("engine_live");
      setPhase("live");
      options.onConnected?.(connectionController.signal);
      for await (const raw of stream) {
        if (controller.signal.aborted || connectionController.signal.aborted) return;
        lastEventAt = Date.now();
        options.onEvent(raw);
      }
      if (!controller.signal.aborted && activeConnectionController === connectionController) {
        scheduleRetry("reconnecting");
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (connectionController.signal.aborted || !isAuthError(error)) {
        scheduleRetry("reconnecting");
      } else if (generation !== connectGeneration) {
        scheduleRetry("reconnecting");
      } else {
        scheduleRetry("auth-blocked");
      }
    } finally {
      if (activeConnectionController === connectionController) activeConnectionController = null;
    }
  };

  const notifyGenerationChanged = () => {
    if (disposed || controller.signal.aborted) return;
    generation += 1;
    retryDelayMs = retryInitialDelayMs;
    authRetryDelayMs = authRetryInitialDelayMs;
    const active = activeConnectionController;
    if (active && !active.signal.aborted) return;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    void connect();
  };

  options.onPhaseChange?.(phase);
  void connect();
  const watchdogTimer = setInterval(() => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    const active = activeConnectionController;
    if (!active || active.signal.aborted) return;
    if (Date.now() - lastEventAt < staleStreamMs) return;
    active.abort();
    scheduleRetry("stale");
  }, watchdogIntervalMs);

  return {
    notifyGenerationChanged,
    getPhase: () => phase,
    dispose: () => {
      diagnostics.dispose();
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(watchdogTimer);
      activeConnectionController?.abort();
      controller.abort();
    },
  };
}
