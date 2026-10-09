import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { observeSendStep } from "../src/app/lib/send-step-diagnostics";

let now = 0;
beforeEach(() => {
  now = 0;
  jest.useFakeTimers();
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function advance(ms: number) {
  now += ms;
  jest.advanceTimersByTime(ms);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("warns once at the threshold while still pending, preserving the result", async () => {
  const pending = deferred<object>();
  const value = { prompt: "synthetic-private-prompt", token: "synthetic-private-token" };
  let settled = false;
  const operation = jest.fn(() => pending.promise);
  const result = observeSendStep("history", operation).then((value) => { settled = true; return value; });
  advance(1_999);
  expect(console.warn).not.toHaveBeenCalled();
  advance(1);
  expect(console.warn).toHaveBeenCalledWith("[send-step] Still pending", {
    step: "history", durationMs: 2_000, thresholdMs: 2_000,
  });
  expect(settled).toBe(false);
  advance(60_000);
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  pending.resolve(value);
  expect(await result).toBe(value);
  advance(60_000);
  expect(console.warn).toHaveBeenCalledTimes(1);
});

test("fast success clears its timer without warning", async () => {
  const clear = spyOn(globalThis, "clearTimeout");
  const value = { id: "synthetic-private-id" };
  expect(await observeSendStep("attachments_preparation", () => Promise.resolve(value))).toBe(value);
  expect(clear).toHaveBeenCalledTimes(1);
  advance(60_000);
  expect(console.warn).not.toHaveBeenCalled();
});

test("fast rejection clears its timer and preserves the exact error", async () => {
  const clear = spyOn(globalThis, "clearTimeout");
  const error = new Error("synthetic-private-token https://synthetic.invalid/private");
  await expect(observeSendStep("archive_validation", () => Promise.reject(error))).rejects.toBe(error);
  expect(clear).toHaveBeenCalledTimes(1);
  advance(60_000);
  expect(console.warn).not.toHaveBeenCalled();
});

test("synchronous throw clears its timer and preserves the exact error", async () => {
  const clear = spyOn(globalThis, "clearTimeout");
  const error = new Error("synthetic-private-error");
  await expect(observeSendStep("engine_prompt_admission", () => { throw error; })).rejects.toBe(error);
  expect(clear).toHaveBeenCalledTimes(1);
  advance(60_000);
  expect(console.warn).not.toHaveBeenCalled();
});

test("slow rejection logs only the static step and timing, never the error or operation data", async () => {
  const warn = spyOn(console, "warn");
  const clear = spyOn(globalThis, "clearTimeout");
  const pending = deferred<never>();
  const error = new Error("synthetic-private-prompt synthetic-private-id https://synthetic.invalid/private synthetic-private-token");
  const outcome = observeSendStep("v2_native_prompt", () => pending.promise).catch((cause: unknown) => cause);
  advance(2_000);
  pending.reject(error);
  expect(await outcome).toBe(error);
  expect(clear).toHaveBeenCalledTimes(1);
  advance(60_000);
  expect(warn.mock.calls).toEqual([["[send-step] Still pending", {
    step: "v2_native_prompt", durationMs: 2_000, thresholdMs: 2_000,
  }]]);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic");
});

test("simultaneous steps have independent thresholds and cleanup", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const firstResult = observeSendStep("history", () => first.promise);
  advance(1_000);
  const secondResult = observeSendStep("v2_permission", () => second.promise);
  advance(1_000);
  expect(console.warn).toHaveBeenCalledTimes(1);
  first.resolve("first");
  expect(await firstResult).toBe("first");
  advance(1_000);
  expect(console.warn).toHaveBeenCalledTimes(2);
  expect(console.warn).toHaveBeenLastCalledWith("[send-step] Still pending", {
    step: "v2_permission", durationMs: 2_000, thresholdMs: 2_000,
  });
  second.resolve("second");
  expect(await secondResult).toBe("second");
  advance(60_000);
  expect(console.warn).toHaveBeenCalledTimes(2);
});

test("simultaneous invocations of the same step each warn once", async () => {
  const first = deferred<void>();
  const second = deferred<void>();
  const results = [
    observeSendStep("interruption", () => first.promise),
    observeSendStep("interruption", () => second.promise),
  ];
  advance(2_000);
  expect(console.warn).toHaveBeenCalledTimes(2);
  advance(60_000);
  expect(console.warn).toHaveBeenCalledTimes(2);
  first.resolve();
  second.resolve();
  await Promise.all(results);
});
