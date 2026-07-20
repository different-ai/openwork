import { describe, expect, test } from "bun:test";

import { classifyRouteSessionReadError } from "../src/react-app/shell/route-workspaces";
import {
  mergeWorkspaceRouteSession,
  preserveWorkspaceRouteSession,
  removeWorkspaceRouteSession,
  sessionIdForLegacyWorkspaceInference,
} from "../src/react-app/shell/workspace-routes";

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
    expect(classifyRouteSessionReadError(new Error("request timed out"))).toBe("retryable");
    expect(classifyRouteSessionReadError(Object.assign(new Error("forbidden"), { status: 403 }))).toBe("error");
  });
});
