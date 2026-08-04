import type {
  ScheduledTaskTickInput,
  ScheduledTaskTickPort,
  ScheduledTaskTickResult,
} from "@openwork/scheduled-tasks";
import type { ScheduledTaskService } from "./scheduled-task-service.js";

export interface CreateScheduledTaskSchedulerOptions {
  service: ScheduledTaskService;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface ScheduledTaskScheduler extends ScheduledTaskTickPort {
  readonly running: boolean;
  start(options?: { immediate?: boolean }): void;
  stop(): Promise<void>;
}

export function createScheduledTaskScheduler(
  options: CreateScheduledTaskSchedulerOptions,
): ScheduledTaskScheduler {
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs ?? 30_000));
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeTick: Promise<ScheduledTaskTickResult> | null = null;

  function tick(input: ScheduledTaskTickInput): Promise<ScheduledTaskTickResult> {
    if (activeTick) return activeTick;
    const promise = options.service.tick(input);
    activeTick = promise;
    void promise.then(
      () => {
        if (activeTick === promise) activeTick = null;
      },
      () => {
        if (activeTick === promise) activeTick = null;
      },
    );
    return promise;
  }

  return {
    get running() {
      return timer !== null;
    },

    start(startOptions = {}) {
      if (timer) return;
      timer = setInterval(() => {
        void tick({ now: Date.now(), source: "app" }).catch(
          (error) => options.onError?.(error),
        );
      }, intervalMs);
      timer.unref?.();
      if (startOptions.immediate) {
        void tick({ now: Date.now(), source: "app" }).catch(
          (error) => options.onError?.(error),
        );
      }
    },

    tick,

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (activeTick) await activeTick.catch(() => undefined);
      await options.service.stop("shutdown");
    },
  };
}
