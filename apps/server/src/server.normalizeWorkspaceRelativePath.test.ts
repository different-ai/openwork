import { describe, expect, test } from "bun:test";
import { isSupportedWorkspaceTextFilePath, normalizeWorkspaceRelativePath } from "./server.js";
import { resolveWorkspaceArtifactTargets } from "./routes/files.js";

describe("normalizeWorkspaceRelativePath", () => {
  test("accepts a plain workspace-relative path", () => {
    expect(normalizeWorkspaceRelativePath("notes.md", { allowSubdirs: true })).toBe("notes.md");
    expect(normalizeWorkspaceRelativePath("  notes.md\n", { allowSubdirs: true })).toBe("notes.md");
  });

  test("strips workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("workspace/notes.md", { allowSubdirs: true })).toBe("notes.md");
    expect(normalizeWorkspaceRelativePath("workspace/dir/notes.md", { allowSubdirs: true })).toBe("dir/notes.md");
  });

  test("strips Workspace/<id>/ prefix from rendered artifact paths", () => {
    expect(normalizeWorkspaceRelativePath("Workspace/32423/reports/artifact-eval.md", { allowSubdirs: true })).toBe("reports/artifact-eval.md");
    expect(normalizeWorkspaceRelativePath("workspaces/demo/reports/artifact-eval.csv", { allowSubdirs: true })).toBe("reports/artifact-eval.csv");
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

  test("rejects Windows reserved device names in any segment", () => {
    for (const path of [
      "CON",
      "reports/con.txt",
      "reports/NUL.json",
      "PRN.csv",
      "AUX",
      "COM1.log",
      "reports/com9",
      "LPT1.txt",
      "reports/lpt9.json",
      "CLOCK$",
      "CONIN$.txt",
      "CONOUT$",
    ]) {
      expect(() => normalizeWorkspaceRelativePath(path, { allowSubdirs: true }))
        .toThrow("Path components must not use Windows reserved device names");
    }
  });

  test("rejects alternate data stream colons in any segment", () => {
    for (const path of ["reports/summary.txt:secret", "reports:secret/summary.txt", "C:/summary.txt"]) {
      expect(() => normalizeWorkspaceRelativePath(path, { allowSubdirs: true }))
        .toThrow("Path components must not contain colons");
    }
  });

  test("rejects path segments with trailing dots or spaces", () => {
    for (const path of ["reports/summary.txt.", "reports/summary.txt ", "reports./summary.txt", "reports /summary.txt"]) {
      expect(() => normalizeWorkspaceRelativePath(path, { allowSubdirs: true }))
        .toThrow("Path components must not end with a dot or space");
    }
  });

  test("retains ordinary names that merely resemble Windows devices", () => {
    for (const path of [
      "reports/console.txt",
      "reports/auxiliary.txt",
      "reports/com0.txt",
      "reports/com10.txt",
      "reports/lpt10.txt",
      "reports/revenue report.v1.txt",
    ]) {
      expect(normalizeWorkspaceRelativePath(path, { allowSubdirs: true })).toBe(path);
    }
  });
});

describe("isSupportedWorkspaceTextFilePath", () => {
  test("identifies native video MIME types without treating videos as text", async () => {
    const types = [
      ["clip.mp4", "video/mp4"], ["clip.m4v", "video/mp4"], ["clip.webm", "video/webm"],
      ["clip.MOV", "video/quicktime"], ["clip.ogv", "video/ogg"], ["clip.bin", "application/octet-stream"],
    ];
    for (const [value, contentType] of types) {
      const items = await resolveWorkspaceArtifactTargets(import.meta.dir, [{ kind: "file", value }]);
      expect(items[0]).toMatchObject({ value, contentType });
      expect(isSupportedWorkspaceTextFilePath(value)).toBe(false);
    }
  });

  test("accepts workspace text artifact extensions", () => {
    expect(isSupportedWorkspaceTextFilePath("reports/revenue.csv")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath("reports/revenue.tsv")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath("logs/run.log")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath("config/app.yaml")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath("styles/app.css")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath("dist/index.html")).toBe(true);
  });

  test("keeps accepting OpenCode config/plugin text file extensions", () => {
    expect(isSupportedWorkspaceTextFilePath(".opencode/tools/cloud.ts")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath(".opencode/mcps/cloud.json")).toBe(true);
    expect(isSupportedWorkspaceTextFilePath(".opencode/plugins/cloud.txt")).toBe(true);
  });

  test("rejects unsupported binary-like extensions", () => {
    expect(isSupportedWorkspaceTextFilePath(".opencode/plugins/cloud.bin")).toBe(false);
  });
});
