/** A long gap between ticks indicates an execution pause, such as laptop sleep. */
export interface Scheduler {
  now(): number;
  /** Return a cancellation function; scheduled work must not keep the process alive. */
  after(ms: number, callback: () => void): () => void;
}

export const scheduler: Scheduler = {
  now: Date.now,
  after(ms, callback) {
    const timer = setTimeout(callback, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface ResumeMonitor {
  subscribe(onResume: () => void): () => void;
}

/** Poll only while requests are in flight; all requests share the same clock. */
export function createResumeMonitor(clock: Scheduler = scheduler): ResumeMonitor {
  const listeners = new Set<() => void>();
  let lastTickAt = 0;
  let cancelTick: (() => void) | undefined;

  const tick = () => {
    const now = clock.now();
    const paused = now - lastTickAt > 30_000;
    lastTickAt = now;
    if (paused) {
      for (const listener of listeners) listener();
    }
    cancelTick = listeners.size ? clock.after(5_000, tick) : undefined;
  };

  return {
    subscribe(onResume) {
      listeners.add(onResume);
      if (!cancelTick) {
        lastTickAt = clock.now();
        cancelTick = clock.after(5_000, tick);
      }
      return () => {
        listeners.delete(onResume);
        if (!listeners.size) {
          cancelTick?.();
          cancelTick = undefined;
        }
      };
    },
  };
}

export const resumeMonitor = createResumeMonitor();
