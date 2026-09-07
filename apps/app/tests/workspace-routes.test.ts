import { describe, expect, test } from "bun:test";

import {
  classifyRouteSessionReadError,
  createRouteSession,
  deleteRouteSession,
  mergeRouteWorkspaces,
  readRouteSessionsWithRetry,
  refreshRouteWorkspaceListState,
  stabilizeRouteWorkspaceOrder,
} from "../src/react-app/shell/route-workspaces";
import {
  createRouteWorkspaceLoadCoalescer,
  mapRouteWorkspaceLoads,
} from "../src/react-app/shell/route-refresh-control";
import {
  mergeWorkspaceRouteSession,
  preserveWorkspaceRouteSession,
  removeWorkspaceRouteSession,
  sessionIdForLegacyWorkspaceInference,
  settingsNavigationFromPathname,
  globalExtensionsRoute,
  workspaceExtensionsRoute,
  workspaceSettingsRoute,
} from "../src/react-app/shell/workspace-routes";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

describe("workspace session mutations", () => {
  for (const engine of ["v1", "v2", "legacy"]) {
    test(`creates and deletes through the owning server's ${engine} engine`, async () => {
      const originalFetch = globalThis.fetch;
      const requests: string[] = [];
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        if (path === "/experimental/engine-v2-preview/status") {
          return Response.json({
            enabled: engine === "v2", running: engine === "v2", chatRouting: engine === "v2",
            mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
          }, {
            status: engine === "legacy" ? 404 : 200,
          });
        }
        expect(request.headers.get("Authorization")).toBe("Bearer fixture-token");
        if (request.method === "DELETE") return Response.json(true);
        if (engine === "v2") expect(await request.json()).toMatchObject({ location: { directory: "/existing" } });
        return Response.json({ id: "ses_created", title: "New session", time: { created: 1, updated: 1 } });
      };
      try {
        const endpoint = resolveWorkspaceEndpoint({ id: "ws_existing", workspaceType: "local" }, {
          baseUrl: "http://owner.test", token: "fixture-token",
        });
        if (!endpoint) throw new Error("Workspace endpoint missing");
        expect((await createRouteSession(endpoint, "/existing")).id).toBe("ses_created");
        expect(await deleteRouteSession(endpoint, "ses_created")).toBe(true);
        expect(requests).toEqual([
          "GET /experimental/engine-v2-preview/status",
          `POST /workspace/ws_existing/${engine === "v2" ? "opencode2/api/session" : "opencode/session"}`,
          "GET /experimental/engine-v2-preview/status",
          `DELETE /workspace/ws_existing/${engine === "v2" ? "opencode2/api/session" : "opencode/session"}/ses_created`,
        ]);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }

  test("a failed routing read cannot silently mutate a v1 session", async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      methods.push(request.method);
      return Response.json({ message: "Routing unavailable" }, { status: 503 });
    };
    try {
      const endpoint = resolveWorkspaceEndpoint({ id: "ws_existing", workspaceType: "local" }, {
        baseUrl: "http://owner.test", token: "fixture-token",
      });
      if (!endpoint) throw new Error("Workspace endpoint missing");
      await expect(createRouteSession(endpoint, "/existing")).rejects.toThrow();
      await expect(deleteRouteSession(endpoint, "ses_created")).rejects.toThrow();
      expect(methods).toEqual(["GET", "GET"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("workspace surface routes", () => {
  test("keeps Extensions outside Settings and preserves deep links", () => {
    expect(workspaceSettingsRoute(" workspace/a ", "extensions")).toBe(
      "/workspace/workspace%2Fa/settings/extensions",
    );
    expect(workspaceExtensionsRoute(" workspace/a ")).toBe(
      "/workspace/workspace%2Fa/extensions",
    );
    expect(workspaceExtensionsRoute(" workspace/a ", "/skills/")).toBe(
      "/workspace/workspace%2Fa/extensions/skills",
    );
    expect(globalExtensionsRoute("mcps")).toBe("/extensions/mcps");
  });

  test("menu/agent settings entry keeps the workspace and remembers the open session", () => {
    // Native menu "Settings…" and agent settings.panel.open only know the URL.
    // They must enter Settings the same way the in-app button does, so
    // settingsReturnRoute can bring the user back to the same session.
    const fromSession = settingsNavigationFromPathname(
      "/workspace/workspace%2Fa/session/session_1",
      "general",
    );
    expect(fromSession).toEqual({
      to: "/workspace/workspace%2Fa/settings/general",
      state: { workspaceId: "workspace/a", sessionId: "session_1" },
    });

    expect(settingsNavigationFromPathname("/workspace/workspace_1/session", "updates")).toEqual({
      to: "/workspace/workspace_1/settings/updates",
      state: { workspaceId: "workspace_1", sessionId: null },
    });
    expect(settingsNavigationFromPathname("/workspace/workspace_1/extensions/skills", "ai")).toEqual({
      to: "/workspace/workspace_1/settings/ai",
      state: { workspaceId: "workspace_1", sessionId: null },
    });
    expect(settingsNavigationFromPathname("/automations", "general")).toEqual({
      to: "/settings/general",
      state: { workspaceId: "", sessionId: null },
    });
  });
});

describe("workspace route session inference", () => {
  test("modern workspace routes do not contribute a refresh session id", () => {
    expect(sessionIdForLegacyWorkspaceInference("workspace-a", "session-a")).toBeNull();
    expect(sessionIdForLegacyWorkspaceInference("workspace-a", "session-b")).toBeNull();
    expect(sessionIdForLegacyWorkspaceInference(" workspace-a ", " session-c ")).toBeNull();
  });

  test("legacy session routes contribute a trimmed refresh session id", () => {
    expect(sessionIdForLegacyWorkspaceInference(null, " session-a ")).toBe("session-a");
    expect(sessionIdForLegacyWorkspaceInference("", "session-b")).toBe("session-b");
    expect(sessionIdForLegacyWorkspaceInference("   ", "   ")).toBeNull();
  });
});

describe("workspace route session hydration", () => {
  test("adds an out-of-window routed session without duplicating it", () => {
    const listed = [{ id: "session-200", title: "Recent" }];
    const hydrated = { id: "session-010", title: "Deep link" };

    expect(mergeWorkspaceRouteSession(listed, hydrated)).toEqual([hydrated, ...listed]);
    expect(mergeWorkspaceRouteSession([hydrated, ...listed], { ...hydrated, title: "Updated" })).toEqual([
      { id: "session-010", title: "Updated" },
      ...listed,
    ]);
  });

  test("preserves the active hydrated session across capped list refreshes", () => {
    const hydrated = { id: "session-010", title: "Deep link" };
    const current = [hydrated, { id: "session-200", title: "Recent" }];
    const refreshed = [{ id: "session-201", title: "Newest" }];

    expect(preserveWorkspaceRouteSession(refreshed, current, hydrated.id)).toEqual([hydrated, ...refreshed]);
    expect(preserveWorkspaceRouteSession([hydrated, ...refreshed], current, hydrated.id)).toEqual([
      hydrated,
      ...refreshed,
    ]);
  });

  test("removes a previous out-of-window overlay before another is added", () => {
    const listed = [{ id: "session-200", title: "Recent" }];
    const first = mergeWorkspaceRouteSession(listed, { id: "session-010", title: "First" });
    const restored = removeWorkspaceRouteSession(first, "session-010");
    const second = mergeWorkspaceRouteSession(restored, { id: "session-009", title: "Second" });

    expect(restored).toEqual(listed);
    expect(second).toHaveLength(listed.length + 1);
    expect(second.map((session) => session.id)).toEqual(["session-009", "session-200"]);
  });
});

describe("workspace route session read errors", () => {
  test("distinguishes missing, retryable, and terminal failures", () => {
    expect(classifyRouteSessionReadError(Object.assign(new Error("missing"), { status: 404, code: "session_not_found" }))).toBe("not-found");
    expect(classifyRouteSessionReadError(Object.assign(new Error("workspace missing"), { status: 404, code: "workspace_not_found" }))).toBe("error");
    expect(classifyRouteSessionReadError(Object.assign(new Error("upstream"), { status: 502 }))).toBe("retryable");
    expect(classifyRouteSessionReadError(Object.assign(new Error("engine starting"), { status: 400, code: "opencode_unconfigured" }))).toBe("retryable");
    expect(classifyRouteSessionReadError(new Error("request timed out"))).toBe("retryable");
    expect(classifyRouteSessionReadError(Object.assign(new Error("forbidden"), { status: 403 }))).toBe("error");
  });

  test("retries a bounded runtime startup gap and returns the recovered sessions", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const sessions = await readRouteSessionsWithRetry({
      load: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("engine starting"), {
            status: 400,
            code: "opencode_unconfigured",
          });
        }
        return ["session-1"];
      },
      retryDelaysMs: [250, 750, 1_500],
      wait: async (delayMs) => { waits.push(delayMs); },
    });

    expect(sessions).toEqual(["session-1"]);
    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 750]);
  });

  test("does not retry a terminal authorization failure", async () => {
    let attempts = 0;
    await expect(readRouteSessionsWithRetry({
      load: async () => {
        attempts += 1;
        throw Object.assign(new Error("forbidden"), { status: 403 });
      },
      retryDelaysMs: [250, 750],
      wait: async () => undefined,
    })).rejects.toMatchObject({ status: 403 });
    expect(attempts).toBe(1);
  });
});

describe("workspace route session load budget", () => {
  test("loads workspaces in bounded batches while preserving order", async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const workspaces = Array.from({ length: 10 }, (_, index) => index);

    const resultPromise = mapRouteWorkspaceLoads(workspaces, async (workspace) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
      return `workspace-${workspace}`;
    });

    await Bun.sleep(0);
    expect(active).toBe(4);
    release.splice(0).forEach((resolve) => resolve());
    await Bun.sleep(0);
    expect(active).toBe(4);
    release.splice(0).forEach((resolve) => resolve());
    await Bun.sleep(0);
    expect(active).toBe(2);
    release.splice(0).forEach((resolve) => resolve());

    expect(await resultPromise).toEqual(workspaces.map((workspace) => `workspace-${workspace}`));
    expect(peak).toBe(4);
  });

  test("coalesces one workspace load until its complete retry chain settles", async () => {
    const coalescer = createRouteWorkspaceLoadCoalescer();
    const starts: string[] = [];
    let releaseWorkspaceA: (() => void) | undefined;

    const firstWorkspaceA = coalescer.run("workspace-a", async () => {
      starts.push("workspace-a");
      await new Promise<void>((resolve) => {
        releaseWorkspaceA = resolve;
      });
    });
    const duplicateWorkspaceA = coalescer.run("workspace-a", async () => {
      starts.push("workspace-a-duplicate");
    });
    const workspaceB = coalescer.run("workspace-b", async () => {
      starts.push("workspace-b");
    });

    await Bun.sleep(0);
    expect(duplicateWorkspaceA).toBe(firstWorkspaceA);
    expect(starts).toEqual(["workspace-a", "workspace-b"]);
    expect(coalescer.isInFlight("workspace-a")).toBe(true);

    releaseWorkspaceA?.();
    await Promise.all([firstWorkspaceA, duplicateWorkspaceA, workspaceB]);
    expect(coalescer.isInFlight("workspace-a")).toBe(false);

    await coalescer.run("workspace-a", async () => {
      starts.push("workspace-a-after-settle");
    });
    expect(starts).toEqual(["workspace-a", "workspace-b", "workspace-a-after-settle"]);
  });
});

describe("workspace route list merging", () => {
  const previouslyKnownWorkspaces = [{
    id: "workspace-known",
    name: "Known workspace",
    path: "/tmp/known",
    workspaceType: "local",
    displayNameResolved: "Known workspace",
  }];
  const desktopWorkspaces = [{
    id: "workspace-desktop",
    name: "Desktop workspace",
    path: "/tmp/openwork",
    workspaceType: "local",
    displayNameResolved: "Desktop workspace",
  }];

  test("keeps desktop workspaces when the server workspace list is not an array", () => {
    expect(mergeRouteWorkspaces({ items: undefined }, desktopWorkspaces)).toEqual(desktopWorkspaces);
  });

  test("preserves known workspaces when the route list payload is missing items", async () => {
    await expect(refreshRouteWorkspaceListState({
      load: async () => ({}),
      desktopWorkspaces,
      previousWorkspaces: previouslyKnownWorkspaces,
      orderIds: [],
    })).resolves.toMatchObject({
      error: null,
      usable: false,
      workspaces: previouslyKnownWorkspaces,
    });
  });

  test("preserves known workspaces when the route list payload has undefined items", async () => {
    await expect(refreshRouteWorkspaceListState({
      load: async () => ({ items: undefined }),
      desktopWorkspaces,
      previousWorkspaces: previouslyKnownWorkspaces,
      orderIds: [],
    })).resolves.toMatchObject({
      error: null,
      usable: false,
      workspaces: previouslyKnownWorkspaces,
    });
  });

  test("preserves known workspaces when the route list request rejects", async () => {
    const result = await refreshRouteWorkspaceListState({
      load: async () => {
        throw new Error("workspace list unavailable");
      },
      desktopWorkspaces,
      previousWorkspaces: previouslyKnownWorkspaces,
      orderIds: [],
    });

    expect(result.usable).toBe(false);
    expect(result.workspaces).toEqual(previouslyKnownWorkspaces);
    expect(result.error).toBeInstanceOf(Error);
  });

  test("retries transient workspace-list failures during startup", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const result = await refreshRouteWorkspaceListState({
      load: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("Failed to fetch");
        return { items: previouslyKnownWorkspaces, activeId: previouslyKnownWorkspaces[0]?.id };
      },
      desktopWorkspaces,
      previousWorkspaces: [],
      orderIds: [],
      retryDelaysMs: [250, 750, 1_500],
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });

    expect(attempts).toBe(3);
    expect(waits).toEqual([250, 750]);
    expect(result.error).toBeNull();
    expect(result.usable).toBe(true);
    expect(result.workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-known",
      "workspace-desktop",
    ]);
  });

  test("captures the first visible order so active-workspace refreshes cannot reshuffle the sidebar", () => {
    const alpha = { ...previouslyKnownWorkspaces[0], id: "workspace-alpha" };
    const beta = { ...desktopWorkspaces[0], id: "workspace-beta" };
    const initial = stabilizeRouteWorkspaceOrder([alpha, beta], []);
    const afterBetaActivation = stabilizeRouteWorkspaceOrder([beta, alpha], initial.orderIds);

    expect(initial.orderIds).toEqual(["workspace-alpha", "workspace-beta"]);
    expect(afterBetaActivation.workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-alpha",
      "workspace-beta",
    ]);
  });

  test("appends newly discovered workspaces without displacing the saved order", () => {
    const alpha = { ...previouslyKnownWorkspaces[0], id: "workspace-alpha" };
    const beta = { ...desktopWorkspaces[0], id: "workspace-beta" };
    const gamma = { ...desktopWorkspaces[0], id: "workspace-gamma" };
    const stable = stabilizeRouteWorkspaceOrder(
      [beta, gamma, alpha],
      ["workspace-alpha", "workspace-beta"],
    );

    expect(stable.orderIds).toEqual([
      "workspace-alpha",
      "workspace-beta",
      "workspace-gamma",
    ]);
    expect(stable.workspaces.map((workspace) => workspace.id)).toEqual(stable.orderIds);
  });

  test("keeps temporarily absent workspace positions for the next successful refresh", () => {
    const alpha = { ...previouslyKnownWorkspaces[0], id: "workspace-alpha" };
    const beta = { ...desktopWorkspaces[0], id: "workspace-beta" };
    const duringGap = stabilizeRouteWorkspaceOrder([beta], ["workspace-alpha", "workspace-beta"]);
    const recovered = stabilizeRouteWorkspaceOrder([beta, alpha], duringGap.orderIds);

    expect(duringGap.orderIds).toEqual(["workspace-alpha", "workspace-beta"]);
    expect(duringGap.workspaces.map((workspace) => workspace.id)).toEqual(["workspace-beta"]);
    expect(recovered.workspaces.map((workspace) => workspace.id)).toEqual([
      "workspace-alpha",
      "workspace-beta",
    ]);
  });
});
