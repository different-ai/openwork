type RoutingSource = { key: string; read: () => Promise<boolean> };
type Poll = { refresh: () => void; dispose: () => void };

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
    let delay = 15_000;
    let cancelTimer: (() => void) | undefined;
    const run = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const routing = await source.read();
        if (!disposed && !pending) {
          delay = 15_000;
          options.publish(source.key, routing);
        }
      } catch (error) {
        if (!disposed && !pending) {
          delay = Math.min(delay * 2, 120_000);
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
            }, delay);
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
        delay = 15_000;
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
