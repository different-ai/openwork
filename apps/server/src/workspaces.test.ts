import { describe, expect, test } from "bun:test";

import { findManagedEngineWorkspace } from "./workspaces.js";
import type { WorkspaceInfo } from "./types.js";

function ws(fields: {
  id?: string;
  name?: string;
  path: string;
  preset?: string;
  workspaceType: WorkspaceInfo["workspaceType"];
}): WorkspaceInfo {
  return {
    id: fields.id ?? "ws_test",
    name: fields.name ?? "Workspace",
    path: fields.path,
    preset: fields.preset ?? (fields.workspaceType === "remote" ? "remote" : "starter"),
    workspaceType: fields.workspaceType,
  };
}

describe("findManagedEngineWorkspace", () => {
  test("selects the local workspace in a typical local + remote config", () => {
    // Mirrors the real desktop config: a local workspace followed by an OpenWork
    // remote worker that has no local path.
    const workspaces = [
      ws({ id: "ws_local", path: "/home/user/cloud/work", workspaceType: "local" }),
      ws({ id: "rem_ws", path: "", workspaceType: "remote" }),
    ];
    expect(findManagedEngineWorkspace(workspaces)?.id).toBe("ws_local");
  });

  test("selects the local workspace even when a path-less remote is first", () => {
    // A freshly added remote worker is prepended, putting it at index 0. The
    // engine must still boot in the local workspace instead of skipping startup.
    const workspaces = [
      ws({ id: "rem_ws", path: "", workspaceType: "remote" }),
      ws({ id: "ws_local", path: "/home/user/cloud/work", workspaceType: "local" }),
    ];
    expect(findManagedEngineWorkspace(workspaces)?.id).toBe("ws_local");
  });

  test("returns undefined for a remote-only config", () => {
    const workspaces = [ws({ id: "rem_ws", path: "", workspaceType: "remote" })];
    expect(findManagedEngineWorkspace(workspaces)).toBeUndefined();
  });

  test("ignores a remote workspace that carries a non-empty directory path", () => {
    // OpenCode remotes can store a `directory`, giving the remote a non-empty
    // path; it still runs on its host, so it must not be chosen as the local cwd.
    const workspaces = [ws({ id: "rem_dir", path: "/remote/dir", workspaceType: "remote" })];
    expect(findManagedEngineWorkspace(workspaces)).toBeUndefined();
  });

  test("skips path-less entries and returns the first local workspace with a path", () => {
    const workspaces = [
      ws({ id: "rem_ws", path: "", workspaceType: "remote" }),
      ws({ id: "ws_blank", path: "  ", workspaceType: "local" }),
      ws({ id: "ws_local", path: "/home/user/work", workspaceType: "local" }),
    ];
    expect(findManagedEngineWorkspace(workspaces)?.id).toBe("ws_local");
  });

  test("returns undefined for an empty workspace list", () => {
    expect(findManagedEngineWorkspace([])).toBeUndefined();
  });
});
