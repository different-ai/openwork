import { describe, expect, test } from "bun:test";

import {
  commitRouteWorkspaceSelection,
  createLatestWorkspaceCommitter,
  createRouteWorkspaceLoadCoalescer,
  createRouteWorkspaceSelectionCommitter,
  createRouteRefreshLifecycle,
  planRouteConnectionGap,
  planRouteWorkspaceLoads,
  routeWorkspaceSessionLoadScope,
} from "../src/react-app/shell/route-refresh-control";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import type { RouteWorkspace } from "../src/react-app/shell/route-workspaces";

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("workspace inventory scope", () => {
  const workspace: RouteWorkspace = {
    id: "ws_1", name: "One", displayNameResolved: "One", path: "/tmp/one", workspaceType: "local",
  };
  const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl: "http://localhost:4100", token: "token-1" });

  test("unknown local routing is not v1, but remote inventory does not wait for it", () => {
    expect(routeWorkspaceSessionLoadScope(workspace, endpoint, undefined)).toBeNull();
    expect(routeWorkspaceSessionLoadScope(workspace, null, false)).toBeNull();
    expect(routeWorkspaceSessionLoadScope(workspace, endpoint, false)).not.toBeNull();
    const remote: RouteWorkspace = { ...workspace, workspaceType: "remote" };
    expect(routeWorkspaceSessionLoadScope(remote, endpoint, undefined)).toBe(routeWorkspaceSessionLoadScope(remote, endpoint, true));
    // A missing remote URL still reaches the loader's connection diagnostic.
    expect(routeWorkspaceSessionLoadScope(remote, null, undefined)).not.toBeNull();
  });

  test("engine, endpoint, credentials, mount and directory changes produce a fresh scope", () => {
    if (!endpoint) throw new Error("Expected a local endpoint");
    const scope = routeWorkspaceSessionLoadScope(workspace, endpoint, false);
    expect(routeWorkspaceSessionLoadScope(workspace, endpoint, true)).not.toBe(scope);
    expect(routeWorkspaceSessionLoadScope(workspace, { ...endpoint, token: "token-2" }, false)).not.toBe(scope);
    expect(routeWorkspaceSessionLoadScope(workspace, { ...endpoint, mountedBaseUrl: "http://localhost:4200/workspace/ws_1" }, false)).not.toBe(scope);
    expect(routeWorkspaceSessionLoadScope(workspace, { ...endpoint, mountedBaseUrl: "http://localhost:4100/workspace/ws_2" }, false)).not.toBe(scope);
    expect(routeWorkspaceSessionLoadScope({ ...workspace, path: "/tmp/two" }, endpoint, false)).not.toBe(scope);
  });
});

describe("workspace inventory switching", () => {
  for (const staleCompletesFirst of [true, false]) {
    test(`a delayed v1 list cannot commit or swallow v2 (stale completes ${staleCompletesFirst ? "first" : "last"})`, async () => {
      const coalescer = createRouteWorkspaceLoadCoalescer();
      const v1 = deferred<string[]>();
      const v2 = deferred<string[]>();
      const starts: string[] = [];
      let inventory = ["cached"];
      const load = (engine: string, response: Promise<string[]>) => coalescer.run("ws_1", engine, async (isCurrent) => {
        starts.push(engine);
        const items = await response;
        if (isCurrent()) inventory = items;
      });
      const oldLoad = load("v1", v1.promise);
      await Promise.resolve();
      const freshLoad = load("v2", v2.promise);
      expect(load("v2", v2.promise)).toBe(freshLoad);
      expect(freshLoad).not.toBe(oldLoad);
      await Promise.resolve();
      expect(starts).toEqual(["v1", "v2"]);

      if (staleCompletesFirst) {
        v1.resolve(["obsolete"]);
        await oldLoad;
        expect(inventory).toEqual(["cached"]);
        expect(coalescer.isInFlight("ws_1")).toBe(true);
        expect(load("v2", v2.promise)).toBe(freshLoad);
      }
      v2.resolve(["fresh"]);
      await freshLoad;
      v1.resolve(["obsolete"]);
      await oldLoad;
      expect(inventory).toEqual(["fresh"]);
      expect(coalescer.isInFlight("ws_1")).toBe(false);
    });
  }

  test("an invalidated failed chain cannot diagnose, retry, or release a fresh chain", async () => {
    const coalescer = createRouteWorkspaceLoadCoalescer();
    const old = deferred<void>();
    const fresh = deferred<void>();
    const effects: string[] = [];
    const oldLoad = coalescer.run("ws_1", "endpoint-1", async (isCurrent) => {
      try {
        await old.promise;
      } catch {
        if (isCurrent()) effects.push("diagnose or retry");
      }
    });
    await Promise.resolve();
    coalescer.invalidate("ws_1");
    // Even returning to the same endpoint cannot resurrect its old chain.
    const freshLoad = coalescer.run("ws_1", "endpoint-1", () => fresh.promise);
    old.reject(new Error("obsolete connection failed"));
    await oldLoad;
    expect(effects).toEqual([]);
    expect(coalescer.isInFlight("ws_1")).toBe(true);
    fresh.resolve();
    await freshLoad;
  });

  test("delayed warm-up retries lose ownership when the inventory is replaced", async () => {
    const coalescer = createRouteWorkspaceLoadCoalescer();
    let mayRetry = () => false;
    await coalescer.run("ws_1", "v1", async (isCurrent) => { mayRetry = isCurrent; });
    expect(mayRetry()).toBe(true);
    await coalescer.run("ws_1", "v2", async () => undefined);
    expect(mayRetry()).toBe(false);
  });
});

describe("createLatestWorkspaceCommitter", () => {
  test("coalesces an in-flight switching burst to the last route", async () => {
    const committed: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const committer = createLatestWorkspaceCommitter(async (workspaceId) => {
      committed.push(workspaceId);
      if (workspaceId === "ws_1") await firstBlocked;
    });

    committer.request("ws_1");
    committer.request("ws_2");
    committer.request("ws_3");
    expect(committed).toEqual(["ws_1"]);

    releaseFirst();
    await committer.settled();
    expect(committed).toEqual(["ws_1", "ws_3"]);
  });

  test("does not repeat the active commit when the final route returns to it", async () => {
    const committed: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const committer = createLatestWorkspaceCommitter(async (workspaceId) => {
      committed.push(workspaceId);
      if (committed.length === 1) await firstBlocked;
    });

    committer.request("ws_1");
    committer.request("ws_2");
    committer.request("ws_1");
    releaseFirst();
    await committer.settled();

    expect(committed).toEqual(["ws_1"]);
  });
});

describe("route workspace selection handoff", () => {
  test("keeps the Settings destination behind an in-flight session commit", async () => {
    const committed: string[] = [];
    let releaseSessionCommit: () => void = () => undefined;
    const sessionCommitBlocked = new Promise<void>((resolve) => {
      releaseSessionCommit = resolve;
    });
    const committer = createRouteWorkspaceSelectionCommitter();

    committer.request("ws_1", async (workspaceId) => {
      committed.push(`session:${workspaceId}:start`);
      await sessionCommitBlocked;
      committed.push(`session:${workspaceId}:end`);
    });
    committer.request("ws_2", async (workspaceId) => {
      committed.push(`session:${workspaceId}`);
    });
    committer.request("ws_2", async (workspaceId) => {
      committed.push(`settings:${workspaceId}`);
    });

    expect(committed).toEqual(["session:ws_1:start"]);
    releaseSessionCommit();
    await committer.settled();

    expect(committed).toEqual([
      "session:ws_1:start",
      "session:ws_1:end",
      "settings:ws_2",
    ]);
  });

  test("retries the same destination with the newer route callback after a failed commit", async () => {
    const committed: string[] = [];
    let releaseFailedCommit: () => void = () => undefined;
    const failedCommitBlocked = new Promise<void>((resolve) => {
      releaseFailedCommit = resolve;
    });
    const committer = createRouteWorkspaceSelectionCommitter();

    committer.request("ws_2", async () => {
      committed.push("session:ws_2");
      await failedCommitBlocked;
      throw new Error("stale connection");
    });
    committer.request("ws_2", async () => {
      committed.push("settings:ws_2");
    });

    releaseFailedCommit();
    await committer.settled();
    expect(committed).toEqual(["session:ws_2", "settings:ws_2"]);
  });
});

describe("commitRouteWorkspaceSelection", () => {
  test("serializes desktop mutations before server activation", async () => {
    const calls: string[] = [];
    await commitRouteWorkspaceSelection({
      workspaceId: " ws_2 ",
      desktopRuntime: true,
      setDesktopSelected: async (workspaceId) => { calls.push(`selected:${workspaceId}`); },
      setDesktopRuntimeActive: async (workspaceId) => { calls.push(`runtime:${workspaceId}`); },
      activateWorkspace: async (workspaceId) => { calls.push(`server:${workspaceId}`); },
    });
    expect(calls).toEqual(["selected:ws_2", "runtime:ws_2", "server:ws_2"]);
  });

  test("continues after a desktop persistence failure", async () => {
    const calls: string[] = [];
    await commitRouteWorkspaceSelection({
      workspaceId: "ws_2",
      desktopRuntime: true,
      setDesktopSelected: async () => { throw new Error("write failed"); },
      setDesktopRuntimeActive: async (workspaceId) => { calls.push(`runtime:${workspaceId}`); },
      activateWorkspace: async (workspaceId) => { calls.push(`server:${workspaceId}`); },
    });
    expect(calls).toEqual(["runtime:ws_2", "server:ws_2"]);
  });
});

describe("planRouteWorkspaceLoads", () => {
  test("loads every unloaded workspace with the selected workspace first", () => {
    expect(planRouteWorkspaceLoads(
      ["ws_1", "ws_2", "ws_3", "ws_4"],
      "ws_3",
      new Set(["ws_1"]),
    )).toEqual(["ws_3", "ws_2", "ws_4"]);
  });

  test("still loads other unloaded workspaces when the selected one is loaded", () => {
    expect(planRouteWorkspaceLoads(["ws_1", "ws_2"], "ws_2", new Set(["ws_2"]))).toEqual(["ws_1"]);
  });

  test("returns nothing when every workspace session index is loaded", () => {
    expect(planRouteWorkspaceLoads(["ws_1", "ws_2"], "ws_1", new Set(["ws_1", "ws_2"]))).toEqual([]);
  });

  test("ignores a selected workspace that is not in the list", () => {
    expect(planRouteWorkspaceLoads(["ws_1"], "ws_missing", new Set())).toEqual(["ws_1"]);
  });
});

describe("createRouteRefreshLifecycle", () => {
  test("dedupes refreshes while one is in flight", () => {
    const lifecycle = createRouteRefreshLifecycle();

    const first = lifecycle.begin();
    expect(first).not.toBeNull();
    expect(lifecycle.begin()).toBeNull();

    expect(first?.finish()).toBe(true);
    expect(lifecycle.isInFlight()).toBe(false);
    expect(lifecycle.begin()).not.toBeNull();
  });

  test("supersede cancels the in-flight attempt instead of racing it", () => {
    const lifecycle = createRouteRefreshLifecycle();

    const stale = lifecycle.begin();
    const fresh = lifecycle.begin({ supersede: true });

    expect(stale?.isCurrent()).toBe(false);
    expect(fresh?.isCurrent()).toBe(true);

    // The superseded attempt no longer owns the in-flight slot, so its
    // completion cannot re-open the route mid-refresh.
    expect(stale?.finish()).toBe(false);
    expect(lifecycle.isInFlight()).toBe(true);
    expect(fresh?.finish()).toBe(true);
    expect(lifecycle.isInFlight()).toBe(false);
  });
});

describe("planRouteConnectionGap", () => {
  test("desktop gaps retain route state and hold the boot overlay", () => {
    expect(planRouteConnectionGap({ desktopRuntime: true })).toEqual({
      retainExistingState: true,
      markRouteReady: false,
    });
  });

  test("web treats a missing connection as a real disconnected state", () => {
    expect(planRouteConnectionGap({ desktopRuntime: false })).toEqual({
      retainExistingState: false,
      markRouteReady: true,
    });
  });
});

// Mirrors refreshRouteState's control flow: begin → resolve connection →
// staleness check → gap plan or apply → finish, with route readiness reported
// only by the attempt that still owns the refresh. On a desktop gap the
// connection is quarantined (no request may carry the previous bearer token
// to the freed loopback port) while session display state is retained.
type SimulatedRouteState = {
  baseUrl: string;
  token: string;
  sessions: string[];
  routeReady: boolean;
};

function createSimulatedRoute(initial: SimulatedRouteState) {
  const lifecycle = createRouteRefreshLifecycle();
  const state = { ...initial, sessions: [...initial.sessions] };

  const refresh = async (
    resolveConnection: () => Promise<{ baseUrl: string; token: string } | null>,
    options?: { supersede?: boolean },
  ) => {
    const attempt = lifecycle.begin(options);
    if (!attempt) return;
    let routeReadyAfterRefresh = true;
    try {
      const resolution = await resolveConnection();
      if (!attempt.isCurrent()) return;
      if (!resolution) {
        const gapPlan = planRouteConnectionGap({ desktopRuntime: true });
        routeReadyAfterRefresh = gapPlan.markRouteReady;
        // The live connection is quarantined in every gap.
        state.baseUrl = "";
        state.token = "";
        if (!gapPlan.retainExistingState) {
          state.sessions = [];
        }
        return;
      }
      state.baseUrl = resolution.baseUrl;
      state.token = resolution.token;
    } finally {
      attempt.finish();
      if (attempt.isCurrent() && routeReadyAfterRefresh) {
        state.routeReady = true;
      }
    }
  };

  return { state, refresh };
}

describe("desktop restart refresh sequence", () => {
  test("an empty resolution quarantines the connection, retains sessions, and a later one recovers", async () => {
    const route = createSimulatedRoute({
      baseUrl: "http://127.0.0.1:4100",
      token: "tok_before_restart",
      sessions: ["task-1", "task-2"],
      routeReady: false,
    });

    // Local server is restarting: the first resolution has no base URL/token.
    await route.refresh(async () => null);

    // No live endpoint or bearer token survives the gap — the freed loopback
    // port must never receive the previous credentials…
    expect(route.state.baseUrl).toBe("");
    expect(route.state.token).toBe("");
    // …while the session display state is retained for the user.
    expect(route.state.sessions).toEqual(["task-1", "task-2"]);
    // The boot overlay must not be released by the gap refresh.
    expect(route.state.routeReady).toBe(false);

    // The restarted server published fresh connection info.
    await route.refresh(async () => ({ baseUrl: "http://127.0.0.1:4187", token: "tok_after_restart" }));

    expect(route.state.baseUrl).toBe("http://127.0.0.1:4187");
    expect(route.state.token).toBe("tok_after_restart");
    expect(route.state.sessions).toEqual(["task-1", "task-2"]);
    expect(route.state.routeReady).toBe(true);
  });

  test("a stale slow refresh cannot overwrite the recovered connection", async () => {
    const route = createSimulatedRoute({
      baseUrl: "",
      token: "",
      sessions: ["task-1"],
      routeReady: false,
    });

    let releaseStaleResolution: (value: null) => void = () => {};
    const staleResolution = new Promise<null>((resolve) => {
      releaseStaleResolution = resolve;
    });

    // A refresh starts against the restarting server and hangs on resolution.
    const staleRun = route.refresh(() => staleResolution);
    // The republished server settings supersede it with a fresh refresh.
    await route.refresh(
      async () => ({ baseUrl: "http://127.0.0.1:4187", token: "tok_recovered" }),
      { supersede: true },
    );

    expect(route.state.baseUrl).toBe("http://127.0.0.1:4187");
    expect(route.state.routeReady).toBe(true);

    // The stale attempt finally resolves empty — after the recovery. Its
    // completion must change nothing.
    releaseStaleResolution(null);
    await staleRun;

    expect(route.state.baseUrl).toBe("http://127.0.0.1:4187");
    expect(route.state.token).toBe("tok_recovered");
    expect(route.state.sessions).toEqual(["task-1"]);
    expect(route.state.routeReady).toBe(true);
  });
});
