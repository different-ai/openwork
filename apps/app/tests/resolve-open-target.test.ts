import { describe, expect, test } from "bun:test";

import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import {
  isWorkspaceContainedArtifactTarget,
  localArtifactPath,
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
  test("native file actions preserve local paths without accepting schemes or network shares", () => {
    expect(localArtifactPath("/workspace", "/tmp/Fresh Start.png")).toBe("/tmp/Fresh Start.png");
    expect(localArtifactPath("/workspace", "images/Result.png")).toBe("/workspace/images/Result.png");
    expect(localArtifactPath("/workspace", "images/Result%20Final.png")).toBe("/workspace/images/Result%20Final.png");
    expect(localArtifactPath("/", "Result.png")).toBe("/Result.png");
    expect(localArtifactPath("/workspace", "file:///tmp/Fresh%20Start.png")).toBe("/tmp/Fresh Start.png");
    expect(localArtifactPath("C:/Work", "C:\\Images\\Result.png")).toBe("C:\\Images\\Result.png");
    for (const value of ["https://example.com/image.png", "javascript:alert(1)", "file://host/image.png", "//host/image.png", "\\\\host\\image.png", "image\0.png"]) {
      expect(localArtifactPath("/workspace", value)).toBeNull();
    }
    expect(localArtifactPath(undefined, "image.png")).toBeNull();
  });

  test.each([
    "../../private/key.txt", "images/../key.txt", "./image.png", "images/./image.png",
    "..\\private\\key.txt", "images\\..\\key.txt", "images\\.\\image.png",
    "%2e%2e/private/key.txt", "images/%2E%2e/key.txt", "images/%2e/image.png",
    "images%2f..%2fkey.txt", "images%5c..%5ckey.txt", "..%20/key.txt",
    "%2f%2fhost/image.png", "%5chost/image.png", "https%3a/image.png", "image%00.png",
  ])("rejects unsafe relative native path %s", (path) => {
    expect(localArtifactPath("/workspace", path)).toBeNull();
    expect(localArtifactPath("C:\\Work", path)).toBeNull();
  });

  test("accepts verified files even when they need the default application", async () => {
    const file: OpenTarget = { ...target, value: "archive.zip", preview: "external", exists: true };
    expect(await resolveCollectibleOpenTarget({ resolveArtifacts: async () => ({ items: [file] }) }, "workspace_1", file)).toEqual(file);
  });
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
