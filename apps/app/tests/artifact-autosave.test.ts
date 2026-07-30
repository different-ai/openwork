import { afterEach, describe, expect, jest, test } from "bun:test";

import { ArtifactAutosaveController } from "../src/react-app/domains/session/artifacts/artifact-autosave";

type PendingWrite = {
  value: string;
  baseUpdatedAt: number | null;
  resolve: (result: { updatedAt: number }) => void;
  reject: (error: unknown) => void;
};

const conflict = new Error("conflict");

function setup() {
  const writes: PendingWrite[] = [];
  const saved: string[] = [];
  const controller = new ArtifactAutosaveController<string>({
    initialValue: "",
    initialUpdatedAt: null,
    debounceMs: 500,
    isConflict: (error) => error === conflict,
    write: (value, baseUpdatedAt) => new Promise((resolve, reject) => {
      writes.push({ value, baseUpdatedAt, resolve, reject });
    }),
    onSaved: (value) => saved.push(value),
  });
  controller.acceptExternal("one", 1);
  return { controller, saved, writes };
}

async function drainMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("artifact autosave lifecycle", () => {
  test("debounces and coalesces edits into the newest payload", async () => {
    jest.useFakeTimers();
    const { controller, writes } = setup();

    controller.edit("two");
    jest.advanceTimersByTime(300);
    controller.edit("three");
    jest.advanceTimersByTime(499);
    expect(writes).toHaveLength(0);

    jest.advanceTimersByTime(1);
    expect(writes).toMatchObject([{ value: "three", baseUpdatedAt: 1 }]);
    writes[0]!.resolve({ updatedAt: 2 });
    await drainMicrotasks();
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, baseUpdatedAt: 2, status: "idle" });
  });

  test("orders one write at a time and saves edits made during a write against its matching result", async () => {
    jest.useFakeTimers();
    const { controller, saved, writes } = setup();

    controller.edit("two");
    jest.advanceTimersByTime(500);
    controller.edit("three");
    controller.edit("four");
    expect(writes).toMatchObject([{ value: "two", baseUpdatedAt: 1 }]);

    writes[0]!.resolve({ updatedAt: 2 });
    await drainMicrotasks();
    expect(writes).toMatchObject([
      { value: "two", baseUpdatedAt: 1 },
      { value: "four", baseUpdatedAt: 2 },
    ]);
    expect(controller.getSnapshot()).toMatchObject({ value: "four", dirty: true, baseUpdatedAt: 2 });
    expect(saved).toEqual([]);

    writes[1]!.resolve({ updatedAt: 3 });
    await drainMicrotasks();
    expect(controller.getSnapshot()).toMatchObject({ value: "four", dirty: false, baseUpdatedAt: 3 });
    expect(saved).toEqual(["four"]);
  });

  test("stops on conflict and retries only the newest draft against the reviewed base", async () => {
    jest.useFakeTimers();
    const { controller, writes } = setup();

    controller.edit("two");
    jest.advanceTimersByTime(500);
    writes[0]!.reject(conflict);
    await drainMicrotasks();
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, failure: "conflict", baseUpdatedAt: 1 });

    controller.edit("newest");
    jest.advanceTimersByTime(5_000);
    expect(writes).toHaveLength(1);
    controller.retry(9);
    expect(writes[1]).toMatchObject({ value: "newest", baseUpdatedAt: 9 });
    expect(controller.getSnapshot()).toMatchObject({ failure: "conflict", status: "saving" });

    writes[1]!.resolve({ updatedAt: 10 });
    await drainMicrotasks();
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, failure: null, baseUpdatedAt: 10 });
  });

  test("keeps the newest draft after a retryable failure", async () => {
    jest.useFakeTimers();
    const { controller, writes } = setup();
    const failure = new Error("offline");

    controller.edit("two");
    jest.advanceTimersByTime(500);
    writes[0]!.reject(failure);
    await drainMicrotasks();
    controller.edit("latest while offline");
    expect(controller.getSnapshot()).toMatchObject({ value: "latest while offline", failure: "error", error: failure });

    controller.retry();
    expect(writes[1]).toMatchObject({ value: "latest while offline", baseUpdatedAt: 1 });
  });

  test("explicit reload clears stopped state and replaces the draft", async () => {
    jest.useFakeTimers();
    const { controller, writes } = setup();
    const sourceRevision = controller.getSnapshot().sourceRevision;

    controller.edit("local");
    jest.advanceTimersByTime(500);
    writes[0]!.reject(conflict);
    await drainMicrotasks();
    controller.applyReload("external", 8);

    expect(controller.getSnapshot()).toMatchObject({
      value: "external",
      baseUpdatedAt: 8,
      dirty: false,
      failure: null,
      sourceRevision: sourceRevision + 1,
    });
  });

  test("ignores stale external refreshes while dirty or saving", () => {
    jest.useFakeTimers();
    const { controller } = setup();

    controller.edit("local");
    expect(controller.acceptExternal("stale", 2)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ value: "local", baseUpdatedAt: 1, dirty: true });
  });

  test("accepts an external refresh when the local draft is clean", () => {
    const { controller } = setup();
    const sourceRevision = controller.getSnapshot().sourceRevision;

    expect(controller.acceptExternal("external", 2)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({
      value: "external",
      baseUpdatedAt: 2,
      dirty: false,
      sourceRevision: sourceRevision + 1,
    });
  });

  test("does not roll back a matching clean payload to stale target metadata", () => {
    const { controller } = setup();
    const sourceRevision = controller.getSnapshot().sourceRevision;

    expect(controller.acceptExternal("one", 0)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({
      value: "one",
      baseUpdatedAt: 1,
      dirty: false,
      sourceRevision,
    });
  });

  test("flushes a pending debounce during lifecycle cleanup", () => {
    jest.useFakeTimers();
    const { controller, writes } = setup();

    controller.edit("pending");
    controller.dispose();
    expect(writes).toMatchObject([{ value: "pending", baseUpdatedAt: 1 }]);
    jest.advanceTimersByTime(1_000);
    expect(writes).toHaveLength(1);
  });
});
