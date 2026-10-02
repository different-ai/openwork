import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { OpenworkServerError, type WorkspaceDefaultModelRef } from "../src/app/lib/openwork-server";
import {
  useWorkspaceDefaultModelSync,
  WorkspaceDefaultModelSync,
  workspaceDefaultModelPayload,
  type UseWorkspaceDefaultModelSyncInput,
  type WorkspaceDefaultModelSyncTarget,
} from "../src/react-app/kernel/workspace-default-model-sync";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });

function manualTimers() {
  const timers = new Map<number, () => void>();
  let nextId = 0;
  return {
    scheduleTimer: (run: () => void) => {
      const id = nextId++;
      timers.set(id, run);
      return () => { timers.delete(id); };
    },
    flush: () => {
      const runs = [...timers.values()];
      timers.clear();
      for (const run of runs) run();
    },
    get size() { return timers.size; },
  };
}

function target(
  calls: Array<WorkspaceDefaultModelRef | null>,
  options: { serverKey?: string; workspaceKey?: string; fail?: () => unknown } = {},
): WorkspaceDefaultModelSyncTarget {
  return {
    serverKey: options.serverKey ?? "https://server.invalid",
    workspaceKey: options.workspaceKey ?? "ws_1",
    put: async (model) => {
      calls.push(model);
      if (options.fail) throw options.fail();
    },
  };
}

const modelA = { providerID: "fixture", modelID: "model-a" };
const modelB = { providerID: "fixture", modelID: "model-b", variant: "high" };

describe("workspace default model sync", () => {
  test("debounces bursts into one write of the latest value", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<WorkspaceDefaultModelRef | null> = [];
    sync.schedule(target(calls), modelA);
    sync.schedule(target(calls), modelB);
    expect(timers.size).toBe(1);
    timers.flush();
    await sync.idle();
    expect(calls).toEqual([modelB]);
  });

  test("skips values already sent and writes again after a change or clear", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<WorkspaceDefaultModelRef | null> = [];
    sync.schedule(target(calls), modelA);
    timers.flush();
    await sync.idle();
    sync.schedule(target(calls), modelA);
    expect(timers.size).toBe(0);
    sync.schedule(target(calls), null);
    timers.flush();
    await sync.idle();
    expect(calls).toEqual([modelA, null]);
  });

  test("forgetting a workspace (server reconnect) writes the same value again", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<WorkspaceDefaultModelRef | null> = [];
    sync.schedule(target(calls), modelA);
    timers.flush();
    await sync.idle();
    sync.forget({ serverKey: "https://server.invalid", workspaceKey: "ws_1" });
    sync.schedule(target(calls), modelA);
    timers.flush();
    await sync.idle();
    expect(calls).toEqual([modelA, modelA]);
  });

  test("a failed write is retried on the next schedule and never throws", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<WorkspaceDefaultModelRef | null> = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      sync.schedule(target(calls, { fail: () => new Error("offline") }), modelA);
      timers.flush();
      await sync.idle();
    } finally {
      console.warn = originalWarn;
    }
    sync.schedule(target(calls), modelA);
    timers.flush();
    await sync.idle();
    expect(calls).toEqual([modelA, modelA]);
  });

  test("an older server without the route disables sync for that server only", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<WorkspaceDefaultModelRef | null> = [];
    sync.schedule(target(calls, { fail: () => new OpenworkServerError(404, "not_found", "Not found") }), modelA);
    timers.flush();
    await sync.idle();
    expect(sync.isDisabled("https://server.invalid")).toBe(true);
    sync.schedule(target(calls, { workspaceKey: "ws_2" }), modelB);
    expect(timers.size).toBe(0);
    sync.schedule(target(calls, { serverKey: "https://other.invalid" }), modelB);
    timers.flush();
    await sync.idle();
    expect(calls).toEqual([modelA, modelB]);
  });

  test("an unknown workspace does not disable the server", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<WorkspaceDefaultModelRef | null> = [];
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      sync.schedule(target(calls, { fail: () => new OpenworkServerError(404, "workspace_not_found", "Workspace not found") }), modelA);
      timers.flush();
      await sync.idle();
    } finally {
      console.warn = originalWarn;
    }
    expect(sync.isDisabled("https://server.invalid")).toBe(false);
  });

  test("payload is the effective model, trimmed, with an optional variant", () => {
    expect(workspaceDefaultModelPayload(null, "high")).toBeNull();
    expect(workspaceDefaultModelPayload({ providerID: "", modelID: "model-a" }, null)).toBeNull();
    expect(workspaceDefaultModelPayload({ providerID: " fixture ", modelID: "model-a" }, "  ")).toEqual(modelA);
    expect(workspaceDefaultModelPayload({ providerID: "fixture", modelID: "model-b" }, "high")).toEqual(modelB);
  });

  test("hook waits for entitlement, writes on change, and rewrites after a reconnect", async () => {
    const timers = manualTimers();
    const sync = new WorkspaceDefaultModelSync({ scheduleTimer: timers.scheduleTimer });
    const calls: Array<[string, WorkspaceDefaultModelRef | null]> = [];
    const endpoint = {
      baseUrl: "https://server.invalid",
      token: "token",
      workspaceId: "ws_1",
      client: {
        setWorkspaceDefaultModel: async (workspaceId: string, model: WorkspaceDefaultModelRef | null) => {
          calls.push([workspaceId, model]);
          return { model, updatedAt: 1 };
        },
      },
    };
    function Probe(props: Omit<UseWorkspaceDefaultModelSyncInput, "endpoint" | "sync">) {
      useWorkspaceDefaultModelSync({ ...props, endpoint, sync });
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const render = async (props: Omit<UseWorkspaceDefaultModelSyncInput, "endpoint" | "sync">) => {
      await act(async () => { root.render(createElement(Probe, props)); });
      timers.flush();
      await sync.idle();
    };

    // Entitlement still being checked: nothing is written yet.
    await render({ connected: true, pending: true, model: null, variant: null });
    expect(calls).toEqual([]);
    await render({ connected: true, pending: false, model: modelA, variant: null });
    // Re-rendering with an equal model object does not write again.
    await render({ connected: true, pending: false, model: { ...modelA }, variant: null });
    await render({ connected: true, pending: false, model: { providerID: "fixture", modelID: "model-b" }, variant: "high" });
    await render({ connected: false, pending: false, model: { providerID: "fixture", modelID: "model-b" }, variant: "high" });
    await render({ connected: true, pending: false, model: { providerID: "fixture", modelID: "model-b" }, variant: "high" });
    // Auto dropped and nothing else configured: the server default is cleared.
    await render({ connected: true, pending: false, model: null, variant: null });
    expect(calls).toEqual([["ws_1", modelA], ["ws_1", modelB], ["ws_1", modelB], ["ws_1", null]]);
    await act(async () => { root.unmount(); });
    host.remove();
  });
});
