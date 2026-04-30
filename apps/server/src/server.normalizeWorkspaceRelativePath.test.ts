import { describe, expect, test } from "bun:test";
import { isSupportedWorkspaceTextFilePath, normalizeWorkspaceRelativePath } from "./server.js";

describe("normalizeWorkspaceRelativePath", () => {
  test("accepts a plain workspace-relative path", () => {
    expect(normalizeWorkspaceRelativePath("notes.md", { allowSubdirs: true })).toBe("notes.md");
  });

  test("strips workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("workspace/notes.md", { allowSubdirs: true })).toBe("notes.md");
    expect(normalizeWorkspaceRelativePath("workspace/dir/notes.md", { allowSubdirs: true })).toBe("dir/notes.md");
  });

  test("strips /workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("/workspace/notes.md", { allowSubdirs: true })).toBe("notes.md");
    expect(normalizeWorkspaceRelativePath("//workspace/dir/notes.md", { allowSubdirs: true })).toBe("dir/notes.md");
  });

  test("strips ./workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("./workspace/notes.md", { allowSubdirs: true })).toBe("notes.md");
  });

  test("still rejects traversal after stripping prefixes", () => {
    expect(() => normalizeWorkspaceRelativePath("workspace/../secrets.md", { allowSubdirs: true })).toThrow();
    expect(() => normalizeWorkspaceRelativePath("/workspace/../secrets.md", { allowSubdirs: true })).toThrow();
  });

  test("still enforces allowSubdirs", () => {
    expect(() => normalizeWorkspaceRelativePath("workspace/dir/notes.md", { allowSubdirs: false })).toThrow();
  });

  test("treats workspace/ with no file as invalid", () => {
    expect(() => normalizeWorkspaceRelativePath("workspace/", { allowSubdirs: true })).toThrow();
    expect(() => normalizeWorkspaceRelativePath("/workspace/", { allowSubdirs: true })).toThrow();
  });
});

describe("isSupportedWorkspaceTextFilePath", () => {
  test("accepts plugin import text file extensions", () => {
    expect(isSupportedWorkspaceTextFilePath(".opencode/tools/cloud.ts")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath(".opencode/mcps/cloud.json")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath(".opencode/plugins/cloud.txt")).toBe(true);
  });

  test("rejects unsupported binary-like extensions", () => {
    expect(isSupportedWorkspaceTextFilePath(".opencode/plugins/cloud.bin")).toBe(false);
  });
});
