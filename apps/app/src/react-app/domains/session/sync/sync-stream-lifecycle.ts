/**
 * Generation-aware reconnect lifecycle for the workspace event stream.
 *
 * The stream must never park in a terminal dead state: 401/403/404 from the
 * subscribe call can mean a permanently invalid token, but the same statuses
 * occur transiently while the local server restarts or the runtime generation
 * rotates. Auth-shaped failures therefore keep retrying on a slower bounded
 * exponential schedule, and `notifyGenerationChanged` (a rotated token or a
 * new runtime generation) restarts a parked stream immediately with fresh
 * backoff instead of waiting out stale failure evidence.
 *
 * This module is dependency-free on purpose so specs can drive it directly.
 */

export type SyncStreamPhase =
  | "connecting"
  | "live"
  | "reconnecting"
  | "auth-blocked"
  | "stale";

type SyncStreamLifecycleOptions = {
  subscribe: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>;
  onEvent: (event: unknown) => void;
  /**
   * Runs on every successful (re)connect, before events flow. Owners
   * level-reconcile active run statuses here so a cached idle recorded while
   * the stream was down cannot mask work that continued on the server.
   */
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
  /**
   * The credential or runtime generation behind `subscribe` changed. Resets
   * both backoff schedules and, when no healthy connection exists, reconnects
   * immediately. A healthy stream keeps flowing: if the server cuts it over
   * the rotation, the ordinary retry path reconnects with the new generation.
   */
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
    options.onPhaseChange?.(next);
  };

  const scheduleRetry = (reason: "reconnecting" | "auth-blocked" | "stale") => {
    if (disposed || controller.signal.aborted || retryTimer) return;
    activeConnectionController = null;
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
    setPhase("connecting");
    try {
      const stream = await options.subscribe(connectionController.signal);
      retryDelayMs = retryInitialDelayMs;
      authRetryDelayMs = authRetryInitialDelayMs;
      lastEventAt = Date.now();
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
        // The generation rotated while this attempt was in flight, so its
        // auth failure is stale evidence about the previous generation.
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
    // New generation: previous failures no longer predict the next attempt.
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
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(watchdogTimer);
      activeConnectionController?.abort();
      controller.abort();
    },
  };
}
