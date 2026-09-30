import { describe, expect, test } from "bun:test";

import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import {
  isWorkspaceContainedArtifactTarget,
  localArtifactPath,
  nativeFileAction,
  openTargetForHref,
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
  test("explicit links resolve without inventory and preserve exact identity", () => {
    for (const href of ["reports/Report.pdf", "./reports/Report.pdf", "/workspace/reports/Report.pdf", "file:///workspace/reports/Report%20Final.pdf", "C:\\Work\\Report.pdf"]) {
      const resolved = openTargetForHref(href, [], "/workspace");
      expect(resolved?.kind).toBe("file");
      expect(resolved?.exists).toBeUndefined();
      expect(resolved?.preview).toBe("pdf");
    }
    const sibling = { ...target, value: "Report.pdf", exists: true };
    expect(openTargetForHref("/other/Report.pdf", [sibling], "/workspace")?.value).toBe("/other/Report.pdf");
    expect(openTargetForHref("report.pdf", [sibling], "/workspace")?.exists).toBeUndefined();
    expect(openTargetForHref("file:///workspace/Report.pdf", [sibling], "/workspace")).toBe(sibling);
    expect(openTargetForHref("Report.pdf", [], undefined)?.value).toBe("Report.pdf");
  });

  test("explicit links keep full web addresses and reject unsafe file targets", () => {
    const href = "https://example.com/report?q=one#section";
    expect(openTargetForHref(href, [], "/workspace")?.value).toBe(href);
    for (const value of ["#section", "javascript:alert(1)", "mailto:hello@example.com", "file://host/report.pdf", "//host/report.pdf", "\\\\host\\report.pdf", "../report.pdf", "file:///tmp/report.pdf#section", "file:///tmp/%00report.pdf"]) {
      expect(openTargetForHref(value, [], "/workspace")).toBeNull();
    }
  });

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

  test("only workspace files may be handed to the default application", () => {
    expect(nativeFileAction("/workspace", "images/Result.png")).toEqual({ path: "/workspace/images/Result.png", action: "open" });
    expect(nativeFileAction("/workspace/", "/workspace/out/Report.pdf")).toEqual({ path: "/workspace/out/Report.pdf", action: "open" });
    expect(nativeFileAction("C:\\Work", "c:/Work/images/Result.png")).toEqual({ path: "c:/Work/images/Result.png", action: "open" });
    expect(nativeFileAction("/workspace", "images/Result.png", { reveal: true })).toEqual({ path: "/workspace/images/Result.png", action: "reveal" });
    // Paths outside the workspace are located in the file manager, never launched.
    for (const value of ["/tmp/Fresh Start.png", "/workspace-other/Result.png", "/Applications/Utilities/run.command", "file:///Users/me/script.sh", "/workspace/../Result.png"]) {
      expect(nativeFileAction("/workspace", value)?.action).toBe("reveal");
    }
    expect(nativeFileAction("C:\\Work", "D:\\Work\\Result.png")).toEqual({ path: "D:\\Work\\Result.png", action: "reveal" });
    expect(nativeFileAction("/workspace", "https://example.com/run.sh")).toBeNull();
    expect(nativeFileAction(undefined, "/tmp/Result.png")).toEqual({ path: "/tmp/Result.png", action: "reveal" });
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
