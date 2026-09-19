import { afterEach, beforeEach, describe, expect, jest, setSystemTime, spyOn, test } from "bun:test";

import type { OpenworkServerClient } from "../src/app/lib/openwork-server";
import {
  buildOpenworkEnvSystemContext,
  buildOpenworkSessionSystemContext,
  clearOpenworkEnvSystemContextCache,
} from "../src/react-app/domains/session/sync/env-context";
import { useWorkbenchStore, workbenchSessionKey } from "../src/react-app/domains/session/chat/workbench-store";
import { readOpenworkRuntimeFacts, renderOpenworkRuntimeContext } from "../src/react-app/domains/session/sync/runtime-context";

function client(
  keys: string[],
  calls: { count: number },
  lookup?: () => Promise<{ keys: string[] }>,
): OpenworkServerClient {
  return {
    baseUrl: "http://127.0.0.1:3000",
    listUserEnvKeys: () => {
      calls.count += 1;
      return lookup ? lookup() : Promise.resolve({ keys });
    },
  } as OpenworkServerClient;
}

function deferredKeys() {
  return Promise.withResolvers<{ keys: string[] }>();
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

beforeEach(() => {
  clearOpenworkEnvSystemContextCache();
  jest.useFakeTimers();
});

afterEach(() => {
  clearOpenworkEnvSystemContextCache();
  jest.useRealTimers();
  setSystemTime();
  jest.restoreAllMocks();
});

describe("buildOpenworkEnvSystemContext", () => {
  test("lists configured key names without inventing secret values", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOpenworkEnvSystemContext(
      client(["NBA_LIVE_KEY", "bad-key", "ANTHROPIC_API_KEY", "NBA_LIVE_KEY"], calls),
      {
        cacheKey: "session-a",
        readPendingChanges: () => false,
      },
    );

    expect(context).toContain("- ANTHROPIC_API_KEY");
    expect(context).toContain("- NBA_LIVE_KEY");
    expect(context).not.toContain("bad-key");
    expect(context).not.toContain("sk-ant-secret");
    expect(calls.count).toBe(1);
  });

  test("reuses warm hints across sessions only for the same client and runtime", async () => {
    const calls = { count: 0 };
    const server = client(["FIRST_KEY"], calls);
    const options = { runtimeKey: "runtime-a", readPendingChanges: () => false };
    const first = await buildOpenworkEnvSystemContext(server, { ...options, cacheKey: "session-a" });
    expect(await buildOpenworkEnvSystemContext(server, { ...options, cacheKey: "session-b" })).toBe(first);
    expect(calls.count).toBe(1);

    server.listUserEnvKeys = client(["SECOND_KEY"], calls).listUserEnvKeys;
    const otherRuntime = await buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "runtime-b" });
    expect(otherRuntime).toContain("SECOND_KEY");
    expect(otherRuntime).not.toContain("FIRST_KEY");
    expect(await buildOpenworkEnvSystemContext(server, options)).toBe(first);
    expect(calls.count).toBe(2);

    const otherClient = client(["THIRD_KEY"], calls);
    expect(otherClient.baseUrl).toBe(server.baseUrl);
    const isolated = await buildOpenworkEnvSystemContext(otherClient, { ...options, cacheKey: "session-a" });
    expect(isolated).toContain("THIRD_KEY");
    expect(isolated).not.toContain("FIRST_KEY");
    expect(calls.count).toBe(3);
  });

  test("deduplicates in-flight lookups across sessions but not clients or runtimes", async () => {
    const lookup = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => lookup.promise);
    const options = { runtimeKey: "runtime-a", readPendingChanges: () => false };
    const first = buildOpenworkEnvSystemContext(server, { ...options, cacheKey: "session-a" });
    const second = buildOpenworkEnvSystemContext(server, { ...options, cacheKey: "session-b" });
    await flushMicrotasks();
    expect(calls.count).toBe(1);

    const otherRuntime = buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "runtime-b" });
    const otherClient = buildOpenworkEnvSystemContext(client(["ISOLATED_KEY"], calls), options);
    await flushMicrotasks();
    expect(calls.count).toBe(3);
    lookup.resolve({ keys: ["SHARED_KEY"] });
    expect(await first).toContain("SHARED_KEY");
    expect(await second).toBe(await first);
    expect(await otherRuntime).toContain("SHARED_KEY");
    expect(await otherClient).toContain("ISOLATED_KEY");
  });

  test("clear during flight prevents stale results from returning or replacing new hints", async () => {
    const stale = deferredKeys();
    const fresh = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => calls.count === 1 ? stale.promise : fresh.promise);
    const options = { runtimeKey: "runtime-a", readPendingChanges: () => false };
    const first = buildOpenworkEnvSystemContext(server, options);
    await flushMicrotasks();
    clearOpenworkEnvSystemContextCache();
    const second = buildOpenworkEnvSystemContext(server, options);
    fresh.resolve({ keys: ["FRESH_KEY"] });
    expect(await second).toContain("FRESH_KEY");
    stale.resolve({ keys: ["STALE_KEY"] });
    expect(await first).toBeUndefined();
    expect(await buildOpenworkEnvSystemContext(server, options)).toBe(await second);
    expect(calls.count).toBe(2);
  });

  test("does not cache failures and retries synchronous throws and rejected lookups", async () => {
    const calls = { count: 0 };
    const server = client([], calls, () => {
      if (calls.count === 1) throw new Error("private lookup details");
      if (calls.count === 2) return Promise.reject(new Error("private lookup details"));
      return Promise.resolve({ keys: ["RETRY_KEY"] });
    });
    const options = { readPendingChanges: () => false };
    expect(await buildOpenworkEnvSystemContext(server, options)).toBeUndefined();
    expect(await buildOpenworkEnvSystemContext(server, options)).toBeUndefined();
    expect(await buildOpenworkEnvSystemContext(server, options)).toContain("RETRY_KEY");
    expect(calls.count).toBe(3);
  });

  test("caches successful empty results and evicts settled hints at the bound", async () => {
    const calls = { count: 0 };
    const server = client([], calls);
    const options = { readPendingChanges: () => false };
    await buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "runtime-0" });
    await buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "runtime-0", cacheKey: "another-session" });
    expect(calls.count).toBe(1);
    for (let index = 1; index <= 100; index += 1) {
      await buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: `runtime-${index}` });
    }
    expect(calls.count).toBe(101);
    await buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "runtime-0" });
    expect(calls.count).toBe(102);
  });

  test("does not truncate long key lists", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const keys = Array.from({ length: 90 }, (_, index) => `KEY_${index}`);
    const context = await buildOpenworkEnvSystemContext(client(keys, calls), {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });

    expect(context).toContain("- KEY_0");
    expect(context).toContain("- KEY_89");
    expect(context).not.toContain("and 10 more");
  });

  test("skips context while environment changes are pending", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOpenworkEnvSystemContext(client(["ANTHROPIC_API_KEY"], calls), {
      cacheKey: "session-a",
      readPendingChanges: () => true,
    });

    expect(context).toBeUndefined();
    expect(calls.count).toBe(0);
  });

  test("pending changes invalidate warm hints before reuse", async () => {
    const calls = { count: 0 };
    const server = client(["OLD_KEY"], calls);
    let pending = false;
    const options = { readPendingChanges: () => pending };
    await buildOpenworkEnvSystemContext(server, options);
    pending = true;
    expect(await buildOpenworkEnvSystemContext(server, options)).toBeUndefined();
    expect(calls.count).toBe(1);
    pending = false;
    server.listUserEnvKeys = client(["NEW_KEY"], calls).listUserEnvKeys;
    expect(await buildOpenworkEnvSystemContext(server, options)).toContain("NEW_KEY");
    expect(calls.count).toBe(2);
  });

  test("checks pending changes after lookup and retries without caching stale hints", async () => {
    const lookup = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => lookup.promise);
    let pending = false;
    const options = { readPendingChanges: () => pending };
    const result = buildOpenworkEnvSystemContext(server, options);
    await flushMicrotasks();
    pending = true;
    lookup.resolve({ keys: ["OLD_KEY"] });
    expect(await result).toBeUndefined();
    pending = false;
    server.listUserEnvKeys = client(["NEW_KEY"], calls).listUserEnvKeys;
    expect(await buildOpenworkEnvSystemContext(server, options)).toContain("NEW_KEY");
    expect(calls.count).toBe(2);
  });

  test("a joining send checks its own pending changes after the shared lookup", async () => {
    const lookup = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => lookup.promise);
    let pending = false;
    const first = buildOpenworkEnvSystemContext(server, { readPendingChanges: () => false });
    const second = buildOpenworkEnvSystemContext(server, { readPendingChanges: () => pending });
    await flushMicrotasks();
    pending = true;
    lookup.resolve({ keys: ["OLD_KEY"] });
    await first;
    expect(await second).toBeUndefined();
    server.listUserEnvKeys = client(["NEW_KEY"], calls).listUserEnvKeys;
    expect(await buildOpenworkEnvSystemContext(server, { readPendingChanges: () => false })).toContain("NEW_KEY");
    expect(calls.count).toBe(2);
  });

  test("keeps pending lookups deduplicated when the bounded cache is full", async () => {
    const lookup = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => lookup.promise);
    const options = { readPendingChanges: () => false };
    const results = Array.from({ length: 100 }, (_, index) =>
      buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: `runtime-${index}` }));
    await flushMicrotasks();
    expect(await buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "overflow" })).toBeUndefined();
    results.push(buildOpenworkEnvSystemContext(server, { ...options, runtimeKey: "runtime-0" }));
    await flushMicrotasks();
    expect(calls.count).toBe(100);
    lookup.resolve({ keys: ["KEY"] });
    expect((await Promise.all(results)).every((context) => context?.includes("- KEY"))).toBe(true);
  });
});

describe("buildOpenworkSessionSystemContext", () => {
  test("bounds a never-settling optional lookup and emits only one sanitized slow warning", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const calls = { count: 0 };
    const server = client([], calls, () => new Promise(() => {}));
    const options = { runtimeKey: "private-runtime", readPendingChanges: () => false };
    let settled = false;
    const first = buildOpenworkSessionSystemContext(server, { ...options, cacheKey: "private-session" })
      .then((context) => { settled = true; return context; });
    const second = buildOpenworkSessionSystemContext(server, { ...options, cacheKey: "another-session" });
    await flushMicrotasks();
    jest.advanceTimersByTime(999);
    await flushMicrotasks();
    expect(settled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    setSystemTime(new Date(2026, 8, 17, 12));
    jest.advanceTimersByTime(1);
    const expected = renderOpenworkRuntimeContext(readOpenworkRuntimeFacts());
    expect(await first).toBe(expected);
    expect(await second).toBe(expected);
    expect(await buildOpenworkSessionSystemContext(server, options)).toBe(expected);
    expect(calls.count).toBe(1);
    expect(warn.mock.calls).toEqual([["Slow send preparation", {
      step: "environment_keys",
      thresholdMs: 1_000,
      durationMs: expect.any(Number),
    }]]);
  });

  test("a timed-out lookup warms hints in the background without another request", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const lookup = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => lookup.promise);
    const options = { runtimeKey: "runtime-a", readPendingChanges: () => false };
    const first = buildOpenworkSessionSystemContext(server, { ...options, cacheKey: "session-a" });
    await flushMicrotasks();
    jest.advanceTimersByTime(1_000);
    expect(await first).not.toContain("BACKGROUND_KEY");
    expect(await buildOpenworkSessionSystemContext(server, options)).not.toContain("BACKGROUND_KEY");
    expect(calls.count).toBe(1);
    lookup.resolve({ keys: ["BACKGROUND_KEY"] });
    await flushMicrotasks();
    expect(await buildOpenworkSessionSystemContext(server, { ...options, cacheKey: "session-b" })).toContain("BACKGROUND_KEY");
    expect(calls.count).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each(["clear", "pending", "failure"])("does not warm invalid hints after timeout: %s", async (invalidation) => {
    spyOn(console, "warn").mockImplementation(() => {});
    const lookup = deferredKeys();
    const calls = { count: 0 };
    const server = client([], calls, () => lookup.promise);
    let pending = false;
    const options = { readPendingChanges: () => pending };
    const first = buildOpenworkSessionSystemContext(server, options);
    await flushMicrotasks();
    jest.advanceTimersByTime(1_000);
    expect(await first).not.toContain("OLD_KEY");
    if (invalidation === "clear") clearOpenworkEnvSystemContextCache();
    if (invalidation === "pending") pending = true;
    if (invalidation === "failure") lookup.reject(new Error("private failure details"));
    else lookup.resolve({ keys: ["OLD_KEY"] });
    await flushMicrotasks();
    pending = false;
    server.listUserEnvKeys = client(["NEW_KEY"], calls).listUserEnvKeys;
    const next = await buildOpenworkSessionSystemContext(server, options);
    expect(next).toContain("NEW_KEY");
    expect(next).not.toContain("OLD_KEY");
    expect(calls.count).toBe(2);
  });

  test("computes date and side-chat context fresh per send while reusing hints", async () => {
    spyOn(console, "warn").mockImplementation(() => {});
    const original = useWorkbenchStore.getState();
    const main = { workspaceId: "workspace-a", sessionId: "main-a" };
    const otherMain = { workspaceId: "workspace-a", sessionId: "main-b" };
    const side = { workspaceId: "workspace-a", sessionId: "side" };
    const calls = { count: 0 };
    const server = client(["CACHED_KEY"], calls);
    const options = { workspaceId: side.workspaceId, cacheKey: side.sessionId, readPendingChanges: () => false };
    try {
      useWorkbenchStore.setState({ tabs: [main, otherMain, side], sideChats: { [workbenchSessionKey(main)]: side } });
      setSystemTime(new Date(2026, 8, 17, 12));
      const first = await buildOpenworkSessionSystemContext(server, options);
      expect(first).toContain("2026-09-17");
      expect(first).toContain(`Main conversation reference: ${JSON.stringify(main)}`);
      setSystemTime(new Date(2026, 8, 18, 12));
      useWorkbenchStore.setState({ sideChats: { [workbenchSessionKey(otherMain)]: side } });
      const second = await buildOpenworkSessionSystemContext(server, options);
      expect(second).toContain("2026-09-18");
      expect(second).not.toContain("2026-09-17");
      expect(second).toContain(`Main conversation reference: ${JSON.stringify(otherMain)}`);
      expect(second).not.toContain(`Main conversation reference: ${JSON.stringify(main)}`);
      const unrelated = await buildOpenworkSessionSystemContext(server, { ...options, cacheKey: "unrelated" });
      expect(unrelated).not.toContain("side chat");
      const otherWorkspace = await buildOpenworkSessionSystemContext(server, { ...options, workspaceId: "workspace-b" });
      expect(otherWorkspace).not.toContain("side chat");
      expect(calls.count).toBe(1);
      for (const context of [first, second, unrelated, otherWorkspace]) expect(context).toContain("CACHED_KEY");
    } finally {
      useWorkbenchStore.setState(original);
    }
  });

  test("always carries the user's time zone context and appends env keys when present", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };
    const context = await buildOpenworkSessionSystemContext(client(["ANTHROPIC_API_KEY"], calls), {
      cacheKey: "session-a",
      readPendingChanges: () => false,
    });

    const [runtime, env] = context.split("\n\n");
    expect(runtime.startsWith("User context:\n- Time zone: ")).toBe(true);
    expect(runtime).toContain(`- Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone} (UTC`);
    expect(runtime).toContain("- Today's date in that time zone: ");
    expect(runtime).toContain("Resolve \"today\", \"tomorrow\", \"this week\"");
    expect(env).toContain("OpenWork environment variables configured:");
    expect(env).toContain("- ANTHROPIC_API_KEY");
  });

  test("still returns the user context when there are no env keys, no client, or pending changes", async () => {
    clearOpenworkEnvSystemContextCache();
    const calls = { count: 0 };

    const noKeys = await buildOpenworkSessionSystemContext(client([], calls), { cacheKey: "s1", readPendingChanges: () => false });
    const noClient = await buildOpenworkSessionSystemContext(null, { cacheKey: "s2", readPendingChanges: () => false });
    const pending = await buildOpenworkSessionSystemContext(client(["KEY"], calls), { cacheKey: "s3", readPendingChanges: () => true });

    for (const context of [noKeys, noClient, pending]) {
      expect(context.startsWith("User context:")).toBe(true);
      expect(context).not.toContain("OpenWork environment variables configured:");
      expect(context).not.toContain("- KEY");
    }
  });
});
