import { expect, test } from "bun:test";

import {
  EngineInstanceReaper,
  type TrackedEngineInstance,
} from "./engine-instance-reaper.js";

const ENGINE_URL = "http://127.0.0.1:4101";
const TTL_ENV = "OPENWORK_ENGINE_INSTANCE_IDLE_TTL_MS";

type Harness = {
  reaper: EngineInstanceReaper;
  disposed: TrackedEngineInstance[];
  clock: { now: number };
  setBusy: (directory: string, busy: boolean) => void;
  failProbes: (fail: boolean) => void;
  setActiveDirectory: (directory: string | null) => void;
  setEngineBaseUrl: (url: string | null) => void;
};

function createHarness(): Harness {
  const clock = { now: 1_000_000 };
  const busyByDirectory = new Map<string, boolean>();
  const disposed: TrackedEngineInstance[] = [];
  let probesFail = false;
  let activeDirectory: string | null = null;
  let engineBaseUrl: string | null = ENGINE_URL;
  const reaper = new EngineInstanceReaper({
    engineBaseUrl: () => engineBaseUrl,
    activeDirectory: () => activeDirectory,
    directoryBusy: async (entry) => {
      if (probesFail) throw new Error("status probe unavailable");
      return busyByDirectory.get(entry.directory) === true;
    },
    dispose: async (entry) => {
      disposed.push({ ...entry });
    },
    now: () => clock.now,
  });
  return {
    reaper,
    disposed,
    clock,
    setBusy: (directory, busy) => void busyByDirectory.set(directory, busy),
    failProbes: (fail) => void (probesFail = fail),
    setActiveDirectory: (directory) => void (activeDirectory = directory),
    setEngineBaseUrl: (url) => void (engineBaseUrl = url),
  };
}

function use(directory: string) {
  return { directory, workspaceId: `ws-${directory}`, engineBaseUrl: ENGINE_URL };
}

async function withTtl<T>(ttlMs: number, run: () => Promise<T>): Promise<T> {
  const previous = process.env[TTL_ENV];
  process.env[TTL_ENV] = String(ttlMs);
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[TTL_ENV];
    else process.env[TTL_ENV] = previous;
  }
}

test("idle engine instances are reclaimed only after every hold is released", async () => {
  await withTtl(1_000, async () => {
    const idle = createHarness();
    idle.reaper.noteUsed(use("/work/background"));
    idle.clock.now += 999;
    expect(await idle.reaper.sweep()).toBe(0);
    expect(idle.disposed).toHaveLength(0);
    idle.clock.now += 2;
    expect(await idle.reaper.sweep()).toBe(1);
    expect(idle.disposed[0]?.directory).toBe("/work/background");

    const active = createHarness();
    active.setActiveDirectory("/work/active");
    active.reaper.noteUsed(use("/work/active"));
    active.clock.now += 100_000;
    expect(await active.reaper.sweep()).toBe(0);
    expect(active.disposed).toHaveLength(0);
    expect(active.reaper.snapshot()[0]?.directory).toBe("/work/active");

    const running = createHarness();
    running.reaper.noteUsed(use("/work/running"));
    running.setBusy("/work/running", true);
    running.clock.now += 100_000;
    expect(await running.reaper.sweep()).toBe(0);
    running.setBusy("/work/running", false);
    running.clock.now += 999;
    expect(await running.reaper.sweep()).toBe(0);
    running.clock.now += 2;
    expect(await running.reaper.sweep()).toBe(1);

    const watched = createHarness();
    const release = watched.reaper.holdStream(use("/work/watched"));
    watched.clock.now += 100_000;
    expect(await watched.reaper.sweep()).toBe(0);
    release();
    watched.clock.now += 999;
    expect(await watched.reaper.sweep()).toBe(0);
    watched.clock.now += 2;
    expect(await watched.reaper.sweep()).toBe(1);

    const returning = createHarness();
    returning.reaper.noteUsed(use("/work/background"));
    returning.clock.now += 1_001;
    expect(await returning.reaper.sweep()).toBe(1);
    const holdAfterEviction = returning.reaper.holdStream(use("/work/background"));
    expect(returning.reaper.noteUsed(use("/work/background"))).toBe(true);
    expect(returning.reaper.noteUsed(use("/work/background"))).toBe(false);
    holdAfterEviction();

    const unknown = createHarness();
    unknown.reaper.noteUsed(use("/work/unknown"));
    unknown.failProbes(true);
    unknown.clock.now += 100_000;
    expect(await unknown.reaper.sweep()).toBe(0);
    expect(unknown.disposed).toHaveLength(0);

    const retired = createHarness();
    retired.reaper.noteUsed(use("/work/old"));
    retired.setEngineBaseUrl("http://127.0.0.1:4999");
    retired.clock.now += 100_000;
    expect(await retired.reaper.sweep()).toBe(0);
    expect(retired.disposed).toHaveLength(0);
    expect(retired.reaper.snapshot()).toHaveLength(0);

    const unmanaged = createHarness();
    unmanaged.reaper.noteUsed(use("/work/attached"));
    unmanaged.setEngineBaseUrl(null);
    unmanaged.clock.now += 100_000;
    expect(await unmanaged.reaper.sweep()).toBe(0);
    expect(unmanaged.disposed).toHaveLength(0);

    const disabled = createHarness();
    disabled.reaper.noteUsed(use("/work/disabled"));
    disabled.clock.now += 100_000_000;
    expect(await withTtl(0, () => disabled.reaper.sweep())).toBe(0);
    expect(disabled.disposed).toHaveLength(0);
  });
});
