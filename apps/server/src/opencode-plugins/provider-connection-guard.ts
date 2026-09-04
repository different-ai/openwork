/**
 * Provider connection guard.
 *
 * A model request that is in flight when the computer sleeps or the network
 * drops does not fail: the socket is simply half-open and delivers nothing.
 * The engine only notices through its own stream timeout (minutes), and once
 * it does, its retry budget burns on requests that cannot succeed while the
 * machine is still offline. This module wraps the fetch a provider uses so the
 * engine's existing retry/backoff gets a prompt, honest signal instead:
 *
 * - `ConnectionMonitor` watches for a suspend/resume (a wall-clock gap between
 *   ticks) and for the machine's routable addresses changing or disappearing.
 * - `guardProviderFetch` holds a new request while the machine has no network
 *   (bounded, so a misread never blocks a request for long) and, after a
 *   disruption, fails an in-flight request that receives nothing within a
 *   short grace window with a retryable "connection lost" error.
 *
 * The error message is what makes the engine retry: OpenCode classifies
 * provider failures by message, and "connection lost" is on its retryable list.
 * Nothing here changes engine behavior; it only decides how the engine's
 * requests reach the provider.
 */
import { networkInterfaces } from "node:os";

export const CONNECTION_LOST_MESSAGE =
  "Connection lost while waiting for the model (the network changed or the computer resumed from sleep); retrying";

export type Disruption = "resume" | "network-change";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface Timers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

// Handles are opaque to callers so tests can supply manual timers. Real
// timers are unref'd: a pending check must never keep the engine alive.
const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
let nextTimerId = 0;
const defaultTimers: Timers = {
  setTimeout: (callback, ms) => {
    const id = (nextTimerId += 1);
    const handle = setTimeout(() => {
      pendingTimers.delete(id);
      callback();
    }, ms);
    if (typeof handle === "object" && "unref" in handle) handle.unref();
    pendingTimers.set(id, handle);
    return id;
  },
  clearTimeout: (id) => {
    if (typeof id !== "number") return;
    const handle = pendingTimers.get(id);
    if (handle === undefined) return;
    pendingTimers.delete(id);
    clearTimeout(handle);
  },
};

export interface ConnectionMonitorOptions {
  now?: () => number;
  /** Routable (non-loopback, non-link-local) addresses currently assigned. */
  readAddresses?: () => string[];
  timers?: Timers;
  /** Interval between checks. */
  tickMs?: number;
  /** A gap between ticks longer than this means the process was suspended. */
  suspendGapMs?: number;
}

export interface ConnectionMonitor {
  readonly online: boolean;
  /** Run one check now. `start()` schedules this on an interval. */
  tick(): void;
  start(): void;
  stop(): void;
  onDisruption(listener: (kind: Disruption) => void): () => void;
  /**
   * Resolves once the machine has a network route, after `maxWaitMs` even if
   * it does not (the request then fails naturally and the engine retries), or
   * rejects with the signal's reason when the caller aborts.
   */
  waitForOnline(options: { signal?: AbortSignal | null; maxWaitMs: number }): Promise<void>;
}

function isLinkLocal(address: string, family: string | number): boolean {
  if (family === "IPv4" || family === 4) return address.startsWith("169.254.");
  return /^fe[89ab][0-9a-f]:/i.test(address);
}

export function readRoutableAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (isLinkLocal(entry.address, entry.family)) continue;
      addresses.push(entry.address);
    }
  }
  return addresses.sort();
}

export function createConnectionMonitor(options: ConnectionMonitorOptions = {}): ConnectionMonitor {
  const now = options.now ?? Date.now;
  const readAddresses = options.readAddresses ?? readRoutableAddresses;
  const timers = options.timers ?? defaultTimers;
  const tickMs = options.tickMs ?? 5_000;
  const suspendGapMs = options.suspendGapMs ?? 30_000;

  const listeners = new Set<(kind: Disruption) => void>();
  const waiters = new Set<() => void>();
  let online = true;
  let signature: string | null = null;
  let lastTickAt = now();
  let timer: unknown = null;

  const notify = (kind: Disruption) => {
    for (const listener of listeners) listener(kind);
  };

  const tick = () => {
    const at = now();
    const gap = at - lastTickAt;
    lastTickAt = at;
    const resumed = gap > suspendGapMs;

    const addresses = readAddresses();
    const next = addresses.join(",");
    const changed = signature !== null && next !== signature;
    signature = next;
    const wasOnline = online;
    online = addresses.length > 0;

    if (online && !wasOnline) {
      for (const wake of waiters) wake();
      waiters.clear();
    }
    // A change that ends offline has nothing to retry yet: in-flight sockets
    // cannot progress and new requests wait in `waitForOnline`. The retry
    // signal fires once a route exists again.
    if (online && (resumed || changed)) notify(resumed ? "resume" : "network-change");
  };

  return {
    get online() {
      return online;
    },
    tick,
    start() {
      if (timer !== null) return;
      tick();
      const loop = () => {
        timer = timers.setTimeout(() => {
          tick();
          if (timer !== null) loop();
        }, tickMs);
      };
      loop();
    },
    stop() {
      if (timer === null) return;
      timers.clearTimeout(timer);
      timer = null;
    },
    onDisruption(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    waitForOnline({ signal, maxWaitMs }) {
      if (online) return Promise.resolve();
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          waiters.delete(wake);
          timers.clearTimeout(deadline);
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const wake = () => finish(resolve);
        const onAbort = () => finish(() => reject(abortReason(signal)));
        const deadline = timers.setTimeout(() => finish(resolve), maxWaitMs);
        waiters.add(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

function abortReason(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

export function connectionLostError(): Error {
  const error = new Error(CONNECTION_LOST_MESSAGE);
  error.name = "ProviderConnectionLostError";
  return error;
}

export interface GuardOptions {
  now?: () => number;
  timers?: Timers;
  /** How long a request may sit without bytes after a disruption before it is declared dead. */
  graceMs?: number;
  /** How long a new request waits for the network before being sent regardless. */
  offlineHoldMs?: number;
}

const guardedFetches = new WeakSet<FetchLike>();

export function isGuardedFetch(fn: unknown): boolean {
  return typeof fn === "function" && guardedFetches.has(fn as FetchLike);
}

export function guardProviderFetch(fetchFn: FetchLike, monitor: ConnectionMonitor, options: GuardOptions = {}): FetchLike {
  const now = options.now ?? Date.now;
  const timers = options.timers ?? defaultTimers;
  const graceMs = options.graceMs ?? 10_000;
  const offlineHoldMs = options.offlineHoldMs ?? 45_000;

  const guarded: FetchLike = async (input, init) => {
    const callerSignal = init?.signal ?? null;
    await monitor.waitForOnline({ signal: callerSignal, maxWaitMs: offlineHoldMs });

    const abort = new AbortController();
    const signal = callerSignal ? AbortSignal.any([callerSignal, abort.signal]) : abort.signal;
    let rejectLost: (error: Error) => void = () => {};
    const lost = new Promise<never>((_, reject) => {
      rejectLost = reject;
    });
    // Nobody may be racing against `lost` at the moment it settles.
    lost.catch(() => {});

    let lastProgressAt = now();
    let graceTimer: unknown = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let released = false;

    const release = () => {
      if (released) return;
      released = true;
      unsubscribe();
      if (graceTimer !== null) timers.clearTimeout(graceTimer);
      graceTimer = null;
    };
    const fail = () => {
      const error = connectionLostError();
      release();
      rejectLost(error);
      abort.abort(error);
      reader?.cancel(error).catch(() => {});
    };
    const unsubscribe = monitor.onDisruption(() => {
      if (released || graceTimer !== null) return;
      const armedAt = now();
      graceTimer = timers.setTimeout(() => {
        graceTimer = null;
        if (released) return;
        // Only bytes received after the disruption prove the socket survived it.
        if (lastProgressAt <= armedAt) fail();
      }, graceMs);
    });

    let response: Response;
    try {
      response = await Promise.race([fetchFn(input, { ...init, signal }), lost]);
    } catch (error) {
      release();
      throw error;
    }
    lastProgressAt = now();
    if (!response.body) {
      release();
      return response;
    }

    const source = response.body.getReader();
    reader = source;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const part = await Promise.race([source.read(), lost]).catch((error: unknown) => {
          release();
          throw error;
        });
        lastProgressAt = now();
        if (part.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(part.value);
      },
      async cancel(reason) {
        release();
        await source.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  };

  guardedFetches.add(guarded);
  return guarded;
}

let sharedMonitor: ConnectionMonitor | null = null;

/** One monitor per engine process; plugin instances share it. */
export function sharedConnectionMonitor(): ConnectionMonitor {
  if (!sharedMonitor) {
    sharedMonitor = createConnectionMonitor();
    sharedMonitor.start();
  }
  return sharedMonitor;
}
