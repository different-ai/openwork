import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";

import {
  createDashboardLaunchScheduler,
  scheduleDashboardLaunch,
} from "../src/react-app/domains/dashboard/dashboard-launch-scheduler";

function deferred<T = void>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  setSystemTime();
});

describe("dashboard launch scheduler", () => {
  test("admits at most two network phases and releases one slot per completion", async () => {
    const schedule = createDashboardLaunchScheduler();
    const first = deferred<number>();
    const second = deferred<number>();
    const third = deferred<number>();
    const fourth = deferred<number>();
    const started: number[] = [];
    const jobs = [first, second, third, fourth].map((phase, index) => schedule(() => {
      started.push(index);
      return phase.promise;
    }, { signal: new AbortController().signal }));

    expect(started).toEqual([0, 1]);
    first.resolve(10);
    await jobs[0];
    expect(started).toEqual([0, 1, 2]);
    second.resolve(20);
    await jobs[1];
    expect(started).toEqual([0, 1, 2, 3]);
    third.resolve(30);
    fourth.resolve(40);
    expect(await Promise.all(jobs)).toEqual([10, 20, 30, 40]);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  test("shares two module-wide slots without deduplicating jobs using the same callback", async () => {
    const phase = deferred<string>();
    const run = mock(() => phase.promise);
    const jobs = Array.from({ length: 4 }, () => scheduleDashboardLaunch(run, {
      signal: new AbortController().signal,
    }));

    expect(run).toHaveBeenCalledTimes(2);
    expect(jobs[0]).not.toBe(jobs[1]);
    phase.resolve("result");
    expect(await Promise.all(jobs)).toEqual(["result", "result", "result", "result"]);
    expect(run).toHaveBeenCalledTimes(4);
  });

  test("prioritizes user, visible, then offscreen jobs with FIFO ties", async () => {
    const schedule = createDashboardLaunchScheduler(1);
    const phase = deferred();
    const options = { signal: new AbortController().signal };
    const blocking = schedule(() => phase.promise, options);
    const order: string[] = [];
    const enqueue = (name: string, priority: number) => schedule(async () => {
      order.push(name);
    }, { ...options, priority: () => priority });
    const jobs = [
      enqueue("offscreen-first", 0),
      enqueue("visible-first", 1),
      enqueue("user-first", 2),
      enqueue("visible-second", 1),
      enqueue("offscreen-second", 0),
      enqueue("user-second", 2),
    ];

    expect(order).toEqual([]);
    phase.resolve();
    await Promise.all([blocking, ...jobs]);
    expect(order).toEqual([
      "user-first", "user-second", "visible-first", "visible-second", "offscreen-first", "offscreen-second",
    ]);
  });

  test("reads current priorities and treats a throwing getter as offscreen", async () => {
    const schedule = createDashboardLaunchScheduler(1);
    const phase = deferred();
    const options = { signal: new AbortController().signal };
    const blocking = schedule(() => phase.promise, options);
    const order: string[] = [];
    let priority = 0;
    const jobs = [
      schedule(async () => { order.push("promoted"); }, { ...options, priority: () => priority }),
      schedule(async () => { order.push("throwing"); }, {
        ...options,
        priority: () => { throw new Error("unavailable visibility"); },
      }),
      schedule(async () => { order.push("default"); }, options),
      schedule(async () => { order.push("visible"); }, { ...options, priority: () => 1 }),
    ];

    priority = 2;
    phase.resolve();
    await Promise.all([blocking, ...jobs]);
    expect(order).toEqual(["promoted", "visible", "throwing", "default"]);
  });

  test.each([29_999, 30_000, 300_000])("ages queued jobs to priority two at 30 seconds (elapsed=%s)", async (elapsed) => {
    setSystemTime(1_000);
    const schedule = createDashboardLaunchScheduler(1);
    const phase = deferred();
    const options = { signal: new AbortController().signal };
    const blocking = schedule(() => phase.promise, options);
    const order: string[] = [];
    const enqueue = (name: string, priority: number) => schedule(async () => {
      order.push(name);
    }, { ...options, priority: () => priority });
    const oldestUser = enqueue("oldest-user", 2);
    const offscreen = enqueue("offscreen", 0);
    const queuedUser = enqueue("queued-user", 2);
    setSystemTime(1_000 + elapsed);
    const freshUser = enqueue("fresh-user", 2);

    expect(order).toEqual([]);
    phase.resolve();
    await Promise.all([blocking, oldestUser, offscreen, queuedUser, freshUser]);
    expect(order).toEqual(elapsed < 30_000
      ? ["oldest-user", "queued-user", "fresh-user", "offscreen"]
      : ["oldest-user", "offscreen", "queued-user", "fresh-user"]);
  });

  test("removes and rejects an aborted queued job without dispatching or freeing a running slot", async () => {
    const schedule = createDashboardLaunchScheduler(1);
    const phase = deferred();
    const options = { signal: new AbortController().signal };
    const blocking = schedule(() => phase.promise, options);
    const controller = new AbortController();
    const run = mock(async () => "discarded");
    const cancelled = schedule(run, { signal: controller.signal });
    const nextRun = mock(async () => "next");
    const next = schedule(nextRun, options);
    const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    controller.abort(new Error("stale tile"));
    await rejection;
    expect(run).not.toHaveBeenCalled();
    expect(nextRun).not.toHaveBeenCalled();
    phase.resolve();
    await Promise.all([blocking, next]);
    expect(run).not.toHaveBeenCalled();
    expect(nextRun).toHaveBeenCalledTimes(1);
  });

  test("rejects an already-aborted signal without dispatching", async () => {
    const schedule = createDashboardLaunchScheduler(1);
    const controller = new AbortController();
    const run = mock(async () => "discarded");
    controller.abort("stale tile");

    await expect(schedule(run, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
    await expect(schedule(async () => "next", { signal: new AbortController().signal })).resolves.toBe("next");
  });

  test.each(["reject", "throw"])("releases capacity exactly once after a provider %s without retrying", async (failureMode) => {
    const schedule = createDashboardLaunchScheduler(1);
    const phase = deferred();
    const options = { signal: new AbortController().signal };
    const blocking = schedule(() => phase.promise, options);
    const failure = new Error("provider failed");
    const failingRun = mock(() => {
      if (failureMode === "throw") throw failure;
      return Promise.reject(failure);
    });
    const failed = schedule(failingRun, options);
    const rejection = expect(failed).rejects.toBe(failure);
    const nextPhase = deferred();
    const nextRun = mock(() => nextPhase.promise);
    const next = schedule(nextRun, options);
    const lastRun = mock(async () => "last");
    const last = schedule(lastRun, options);

    phase.resolve();
    await blocking;
    await rejection;
    expect(failingRun).toHaveBeenCalledTimes(1);
    expect(nextRun).toHaveBeenCalledTimes(1);
    expect(lastRun).not.toHaveBeenCalled();
    nextPhase.resolve();
    await Promise.all([next, last]);
    expect(failingRun).toHaveBeenCalledTimes(1);
    expect(nextRun).toHaveBeenCalledTimes(1);
    expect(lastRun).toHaveBeenCalledTimes(1);
  });

  test("keeps an aborted running job admitted until settlement without repeating it", async () => {
    const schedule = createDashboardLaunchScheduler(1);
    const phase = deferred<string>();
    const controller = new AbortController();
    const run = mock(() => phase.promise);
    const running = schedule(run, { signal: controller.signal });
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    const options = { signal: new AbortController().signal };
    const nextPhase = deferred();
    const nextRun = mock(() => nextPhase.promise);
    const next = schedule(nextRun, options);
    const lastRun = mock(async () => "last");
    const last = schedule(lastRun, options);

    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(nextRun).not.toHaveBeenCalled();
    phase.resolve("provider result");
    await expect(running).resolves.toBe("provider result");
    controller.abort();
    expect(nextRun).toHaveBeenCalledTimes(1);
    expect(lastRun).not.toHaveBeenCalled();
    nextPhase.resolve();
    await Promise.all([next, last]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(nextRun).toHaveBeenCalledTimes(1);
    expect(lastRun).toHaveBeenCalledTimes(1);
  });

  test.each([0, -1, 1.5, Number.NaN, Infinity])("rejects invalid concurrency limits (%s)", (limit) => {
    expect(() => createDashboardLaunchScheduler(limit)).toThrow(RangeError);
  });
});
