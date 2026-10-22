type RoutingSource = { key: string; read: () => Promise<boolean> };
type Poll = { refresh: () => void; dispose: () => void };

const STEADY_DELAY_MS = 15_000;
const MAX_FAILURE_DELAY_MS = 120_000;
/** Until a scope's first answer, chat has no client, so retry quickly (about 12s
 * in total) while the server starts instead of backing off to 30s after one
 * failure. After that, an unreachable server falls back to the normal backoff. */
const STARTUP_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 2_000, 2_000, 2_000, 2_000];

/** One request per server scope, with completion-based polling. Settings changes
 * coalesce into one follow-up read so an older in-flight snapshot cannot win. */
export function createEngineRoutingPoller(options: {
  publish: (key: string, routing: boolean) => void;
  onError: (error: unknown) => void;
  schedule: (run: () => void, delayMs: number) => () => void;
}) {
  const polls = new Map<string, Poll>();
  function start(source: RoutingSource): Poll {
    let disposed = false;
    let inFlight = false;
    let pending = false;
    let delay = STEADY_DELAY_MS;
    let answered = false;
    let startupFailures = 0;
    let cancelTimer: (() => void) | undefined;
    const run = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      let startupDelay: number | undefined;
      try {
        const routing = await source.read();
        if (!disposed && !pending) {
          answered = true;
          delay = STEADY_DELAY_MS;
          options.publish(source.key, routing);
        }
      } catch (error) {
        if (!disposed && !pending) {
          startupDelay = answered ? undefined : STARTUP_RETRY_DELAYS_MS[startupFailures];
          if (startupDelay === undefined) delay = Math.min(delay * 2, MAX_FAILURE_DELAY_MS);
          else startupFailures += 1;
          options.onError(error);
        }
      } finally {
        inFlight = false;
        if (!disposed) {
          if (pending) {
            pending = false;
            void run();
          } else {
            cancelTimer = options.schedule(() => {
              cancelTimer = undefined;
              void run();
            }, startupDelay ?? delay);
          }
        }
      }
    };
    void run();
    return {
      refresh() {
        if (disposed) return;
        cancelTimer?.();
        cancelTimer = undefined;
        delay = STEADY_DELAY_MS;
        if (inFlight) pending = true;
        else void run();
      },
      dispose() {
        disposed = true;
        cancelTimer?.();
      },
    };
  }
  return {
    reconcile(sources: RoutingSource[]) {
      const keys = new Set(sources.map((source) => source.key));
      for (const [key, poll] of polls) {
        if (keys.has(key)) continue;
        poll.dispose();
        polls.delete(key);
      }
      for (const source of sources) {
        if (!polls.has(source.key)) polls.set(source.key, start(source));
      }
    },
    refresh() {
      for (const poll of polls.values()) poll.refresh();
    },
    dispose() {
      for (const poll of polls.values()) poll.dispose();
      polls.clear();
    },
  };
}
