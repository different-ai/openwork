type DashboardLaunchOptions = {
  signal: AbortSignal;
  priority?: () => number;
};

type QueuedLaunch = {
  priority: () => number;
  start: () => Promise<void>;
};

const PRIORITY_AGING_MS = 30_000;

export function createDashboardLaunchScheduler(limit = 2) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError("Dashboard launch limit must be a positive integer");
  }

  const queue = new Set<QueuedLaunch>();
  let active = 0;
  let pumping = false;

  function pump(): void {
    if (pumping) return;
    pumping = true;
    try {
      while (active < limit && queue.size > 0) {
        let next: QueuedLaunch | undefined;
        let highestPriority = -1;
        for (const job of queue) {
          const priority = job.priority();
          if (priority > highestPriority) {
            next = job;
            highestPriority = priority;
          }
        }
        if (!next) break;
        if (queue.delete(next)) void next.start();
      }
    } finally {
      pumping = false;
    }
  }

  return function schedule<T>(
    run: () => Promise<T>,
    { signal, priority }: DashboardLaunchOptions,
  ): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Dashboard launch aborted", "AbortError"));
    }

    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      const abort = () => {
        if (!queue.delete(job)) return;
        signal.removeEventListener("abort", abort);
        reject(new DOMException("Dashboard launch aborted", "AbortError"));
        pump();
      };
      const job: QueuedLaunch = {
        priority() {
          if (Date.now() - queuedAt >= PRIORITY_AGING_MS) return 2;
          try {
            const value = priority?.() ?? 0;
            return Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 0;
          } catch {
            return 0;
          }
        },
        async start() {
          signal.removeEventListener("abort", abort);
          active += 1;
          try {
            resolve(await run());
          } catch (error) {
            reject(error);
          } finally {
            active -= 1;
            pump();
          }
        },
      };
      queue.add(job);
      signal.addEventListener("abort", abort, { once: true });
      pump();
    });
  };
}

const sharedScheduler = createDashboardLaunchScheduler();

export function scheduleDashboardLaunch<T>(
  run: () => Promise<T>,
  options: DashboardLaunchOptions,
): Promise<T> {
  return sharedScheduler(run, options);
}
