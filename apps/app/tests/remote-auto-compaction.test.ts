import { describe, expect, test } from "bun:test";

import {
  loadAutoCompactContext,
  readAutoCompactContextValue,
  saveAutoCompactContext,
  type AutoCompactContextClient,
} from "../src/react-app/domains/settings/auto-compact-context";

describe("remote auto-compaction settings", () => {
  test("defaults to enabled only after an authoritative config is loaded", () => {
    expect(readAutoCompactContextValue({})).toBe(true);
    expect(readAutoCompactContextValue({ opencode: { compaction: {} } })).toBe(true);
    expect(
      readAutoCompactContextValue({ opencode: { compaction: { auto: false } } }),
    ).toBe(false);
  });

  test("loads from the selected endpoint with its server-side workspace ID", async () => {
    const requestedWorkspaceIds: string[] = [];
    const client: AutoCompactContextClient = {
      getConfig: async (workspaceId) => {
        requestedWorkspaceIds.push(workspaceId);
        return { opencode: { compaction: { auto: false } } };
      },
      patchConfig: async () => undefined,
    };

    const value = await loadAutoCompactContext({
      client,
      workspaceId: "workspace_remote",
    });

    expect(value).toBe(false);
    expect(requestedWorkspaceIds).toEqual(["workspace_remote"]);
  });

  test("writes only through the selected endpoint target", async () => {
    const writes: Array<{ workspaceId: string; auto: boolean }> = [];
    const client: AutoCompactContextClient = {
      getConfig: async () => ({}),
      patchConfig: async (workspaceId, patch) => {
        writes.push({ workspaceId, auto: patch.opencode.compaction.auto });
      },
    };

    await saveAutoCompactContext(
      { client, workspaceId: "workspace_remote" },
      false,
    );

    expect(writes).toEqual([{ workspaceId: "workspace_remote", auto: false }]);
  });
});
