import { describe, expect, test } from "bun:test";

import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import {
  isWorkspaceContainedArtifactTarget,
  resolveCollectibleOpenTarget,
} from "../src/react-app/domains/session/artifacts/resolve-open-target";

const target: OpenTarget = {
  id: "file:src/main.ts",
  kind: "file",
  value: "src/main.ts",
  name: "main.ts",
  preview: "code",
  confidence: 1,
  reason: "test",
};

describe("on-demand artifact target resolution", () => {
  test("accepts verified collectible files contained by the workspace", async () => {
    const resolved = await resolveCollectibleOpenTarget({
      resolveArtifacts: async () => ({ items: [{ ...target, exists: true }] }),
    }, "workspace_1", target);

    expect(resolved).toEqual({ ...target, exists: true });
  });

  test("rejects missing, absolute, and parent-relative targets", async () => {
    const missing = await resolveCollectibleOpenTarget({
      resolveArtifacts: async () => ({ items: [{ ...target, exists: false }] }),
    }, "workspace_1", target);

    expect(missing).toBeNull();
    expect(isWorkspaceContainedArtifactTarget({ ...target, value: "/tmp/main.ts", exists: true })).toBe(false);
    expect(isWorkspaceContainedArtifactTarget({ ...target, value: "../main.ts", exists: true })).toBe(false);
  });
});
