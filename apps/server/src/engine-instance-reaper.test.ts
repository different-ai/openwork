import { afterEach, describe, expect, test } from "bun:test";

import {
  EngineInstanceReaper,
  type EngineInstanceReaperHooks,
  type TrackedEngineInstance,
} from "./engine-instance-reaper.js";

const ENGINE_URL = "http://127.0.0.1:4101";
const TTL_ENV = "OPENWORK_ENGINE_INSTANCE_IDLE_TTL_MS";

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

function setEnv(name: string, value: string): void {
  if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
  process.env[name] = value;
}

type Harness = {
  reaper: EngineInstanceReaper;
  disposed: TrackedEngineInstance[];
  clock: { now: number };
  setBusy: (directory: string, busy: boolean) => void;
  failProbes: (fail: boolean) => void;
  failDisposes: (fail: boolean) => void;
  setActiveDirectory: (directory: string | null) => void;
  setEngineBaseUrl: (url: string | null) => void;
  onBusyProbe: (probe: ((entry: TrackedEngineInstance) => void) | null) => void;
};

function createHarness(overrides?: Partial<EngineInstanceReaperHooks>): Harness {
  const clock = { now: 1_000_000 };
  const busyByDirectory = new Map<string, boolean>();
  const disposed: TrackedEngineInstance[] = [];
  let probesFail = false;
  let disposesFail = false;
  let activeDirectory: string | null = null;
  let engineBaseUrl: string | null = ENGINE_URL;
  let busyProbeObserver: ((entry: TrackedEngineInstance) => void) | null = null;
  const reaper = new EngineInstanceReaper({
    engineBaseUrl: () => engineBaseUrl,
    activeDirectory: () => activeDirectory,
    directoryBusy: async (entry) => {
      busyProbeObserver?.(entry);
      if (probesFail) throw new Error("status probe unavailable");
      return busyByDirectory.get(entry.directory) === true;
    },
    dispose: async (entry) => {
      if (disposesFail) throw new Error("dispose unavailable");
      disposed.push({ ...entry });
    },
    now: () => clock.now,
    ...overrides,
  });
  return {
    reaper,
    disposed,
    clock,
    setBusy: (directory, busy) => void busyByDirectory.set(directory, busy),
    failProbes: (fail) => void (probesFail = fail),
    failDisposes: (fail) => void (disposesFail = fail),
    setActiveDirectory: (directory) => void (activeDirectory = directory),
    setEngineBaseUrl: (url) => void (engineBaseUrl = url),
    onBusyProbe: (probe) => void (busyProbeObserver = probe),
  };
}

function use(directory: string, workspaceId = `ws-${directory}`) {
  return { directory, workspaceId, engineBaseUrl: ENGINE_URL };
}

describe("engine instance reaper", () => {
  test("evicts an idle non-active instance after the TTL and marks its workspace exactly once", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.setActiveDirectory("/work/active");
    harness.reaper.noteUsed(use("/work/active"));
    harness.reaper.noteUsed(use("/work/background"));

    harness.clock.now += 999;
    expect(await harness.reaper.sweep()).toBe(0);

    harness.clock.now += 2;
    expect(await harness.reaper.sweep()).toBe(1);
    expect(harness.disposed.map((entry) => entry.directory)).toEqual(["/work/background"]);
    expect(harness.reaper.snapshot().map((entry) => entry.directory)).toEqual(["/work/active"]);

    // The next traffic for the evicted workspace re-attaches state exactly once.
    expect(harness.reaper.noteUsed(use("/work/background"))).toBe(true);
    expect(harness.reaper.noteUsed(use("/work/background"))).toBe(false);
  });

  test("never evicts the active workspace instance and keeps it warm instead", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.setActiveDirectory("/work/active");
    harness.reaper.noteUsed(use("/work/active"));

    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);
    // The sweep refreshed the active instance, so a later activity check
    // still sees it as recently used.
    expect(harness.reaper.snapshot()[0]?.lastUsedAt).toBe(harness.clock.now);
  });

  test("an open event stream holds the instance; releasing the hold restarts the idle clock", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    const release = harness.reaper.holdStream(use("/work/watched"));

    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);

    release();
    release(); // Idempotent: double release never underflows the hold count.
    harness.clock.now += 999;
    expect(await harness.reaper.sweep()).toBe(0);
    harness.clock.now += 2;
    expect(await harness.reaper.sweep()).toBe(1);
    expect(harness.disposed.map((entry) => entry.directory)).toEqual(["/work/watched"]);
  });

  test("a stream hold never consumes the pending post-eviction mark", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/background"));
    harness.clock.now += 1_001;
    expect(await harness.reaper.sweep()).toBe(1);

    const release = harness.reaper.holdStream(use("/work/background"));
    expect(harness.reaper.noteUsed(use("/work/background"))).toBe(true);
    release();
  });

  test("a busy instance is kept and its idle clock restarts", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/running"));
    harness.setBusy("/work/running", true);

    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);

    harness.setBusy("/work/running", false);
    harness.clock.now += 999;
    expect(await harness.reaper.sweep()).toBe(0);
    harness.clock.now += 2;
    expect(await harness.reaper.sweep()).toBe(1);
  });

  test("an unreadable activity probe never evicts", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/unknown"));
    harness.failProbes(true);

    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);

    harness.failProbes(false);
    expect(await harness.reaper.sweep()).toBe(1);
  });

  test("traffic landing during the activity probe wins over the eviction", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/racing"));
    harness.onBusyProbe(() => {
      harness.reaper.noteUsed(use("/work/racing"));
    });

    harness.clock.now += 1_001;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);
  });

  test("a failed dispose keeps the instance for a later retry", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/background"));
    harness.failDisposes(true);

    harness.clock.now += 1_001;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.reaper.snapshot()).toHaveLength(1);
    expect(harness.reaper.noteUsed(use("/work/background"))).toBe(false);

    harness.failDisposes(false);
    harness.clock.now += 1_001;
    expect(await harness.reaper.sweep()).toBe(1);
  });

  test("instances from a retired engine generation are dropped without a dispose", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/old"));
    harness.setEngineBaseUrl("http://127.0.0.1:4999");

    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);
    expect(harness.reaper.snapshot()).toHaveLength(0);
  });

  test("no managed engine means nothing is swept", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/background"));
    harness.setEngineBaseUrl(null);

    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);
    expect(harness.reaper.snapshot()).toHaveLength(1);
  });

  test("a zero TTL disables eviction entirely", async () => {
    setEnv(TTL_ENV, "0");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/background"));

    harness.clock.now += 100_000_000;
    expect(await harness.reaper.sweep()).toBe(0);
    expect(harness.disposed).toHaveLength(0);
  });

  test("close clears state and stops tracking", async () => {
    setEnv(TTL_ENV, "1000");
    const harness = createHarness();
    harness.reaper.noteUsed(use("/work/background"));
    harness.reaper.close();
    expect(harness.reaper.snapshot()).toHaveLength(0);
    expect(harness.reaper.noteUsed(use("/work/background"))).toBe(false);
    harness.clock.now += 100_000;
    expect(await harness.reaper.sweep()).toBe(0);
  });
});
