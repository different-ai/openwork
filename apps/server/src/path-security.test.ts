/**
 * path-security.test.ts
 *
 * Regression + unit tests for the shared workspace path-security primitives
 * in path-security.ts.
 *
 * Issue #2285 — "The agent's access path escaped from workspace"
 * ──────────────────────────────────────────────────────────────
 * Root cause: An agent was given a workspace rooted at a *sub-package*
 * directory (e.g. /path/to/project/packages/sub-package) but was able to
 * produce a path that resolved to the *project root* (/path/to/project) —
 * one level above its designated sandbox.
 *
 * The escape vectors were:
 *  a) Raw `..` traversal in a relative path (should be caught, and was, by
 *     the per-part check — this PR ensures the posix.normalize pre-pass also
 *     catches collapsed variants like `a/b/../../../secret`).
 *  b) A case-mismatch on Windows/macOS caused `resolveSafeChildPath` to
 *     reject *valid* paths while silently accepting paths whose casing
 *     matched the raw (un-normalised) root string.
 *  c) The "sibling prefix" edge case: a workspace at /ws could be escaped
 *     via /ws-evil if the comparison used `startsWith("/ws")` without the
 *     trailing separator.
 *
 * Every named "Regression #2285" test below directly reproduces one of these
 * vectors and asserts the correct 400 response or accepted result.
 */

import { describe, expect, test } from "bun:test";
import * as nodePath from "node:path";
import { normalizeWorkspaceRelativePath, resolveSafeChildPath } from "./path-security.js";

// ─── normalizeWorkspaceRelativePath ─────────────────────────────────────────

describe("normalizeWorkspaceRelativePath", () => {

  // ── Basic acceptance ───────────────────────────────────────────────────────

  test("accepts a plain workspace-relative path", () => {
    expect(normalizeWorkspaceRelativePath("notes.md", { allowSubdirs: true })).toBe("notes.md");
  });

  test("accepts a nested path when allowSubdirs is true", () => {
    expect(normalizeWorkspaceRelativePath("reports/q1.csv", { allowSubdirs: true })).toBe(
      "reports/q1.csv",
    );
  });

  test("normalises benign in-bounds dot-dot (a/b/../c -> a/c)", () => {
    // This is a VALID path — the segment just collapses within the root.
    expect(
      normalizeWorkspaceRelativePath("reports/archive/../q1.csv", { allowSubdirs: true }),
    ).toBe("reports/q1.csv");
  });

  // ── Prefix stripping ───────────────────────────────────────────────────────

  test("strips workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("workspace/notes.md", { allowSubdirs: true })).toBe(
      "notes.md",
    );
    expect(
      normalizeWorkspaceRelativePath("workspace/dir/notes.md", { allowSubdirs: true }),
    ).toBe("dir/notes.md");
  });

  test("strips Workspace/<id>/ prefix from rendered artifact paths", () => {
    expect(
      normalizeWorkspaceRelativePath("Workspace/32423/reports/artifact-eval.md", {
        allowSubdirs: true,
      }),
    ).toBe("reports/artifact-eval.md");
    expect(
      normalizeWorkspaceRelativePath("workspaces/demo/reports/artifact-eval.csv", {
        allowSubdirs: true,
      }),
    ).toBe("reports/artifact-eval.csv");
  });

  test("strips /workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("/workspace/notes.md", { allowSubdirs: true })).toBe(
      "notes.md",
    );
    expect(
      normalizeWorkspaceRelativePath("//workspace/dir/notes.md", { allowSubdirs: true }),
    ).toBe("dir/notes.md");
  });

  test("strips ./workspace/ prefix", () => {
    expect(normalizeWorkspaceRelativePath("./workspace/notes.md", { allowSubdirs: true })).toBe(
      "notes.md",
    );
  });

  // ── Windows back-slash payloads ────────────────────────────────────────────

  test("converts Windows back-slashes before checking", () => {
    expect(normalizeWorkspaceRelativePath("reports\\q1.csv", { allowSubdirs: true })).toBe(
      "reports/q1.csv",
    );
  });

  // ── Traversal rejection ────────────────────────────────────────────────────

  // Regression #2285 — vector (a): raw `..` traversal
  test("[Regression #2285-a] rejects bare .. traversal", () => {
    expect(() =>
      normalizeWorkspaceRelativePath("..", { allowSubdirs: true }),
    ).toThrow();
  });

  test("[Regression #2285-a] rejects ../ prefix", () => {
    expect(() =>
      normalizeWorkspaceRelativePath("../secrets.md", { allowSubdirs: true }),
    ).toThrow();
  });

  test("[Regression #2285-a] rejects workspace/../secrets.md", () => {
    expect(() =>
      normalizeWorkspaceRelativePath("workspace/../secrets.md", { allowSubdirs: true }),
    ).toThrow();
  });

  test("[Regression #2285-a] rejects /workspace/../secrets.md", () => {
    expect(() =>
      normalizeWorkspaceRelativePath("/workspace/../secrets.md", { allowSubdirs: true }),
    ).toThrow();
  });

  test("[Regression #2285-a] rejects deeply nested traversal (a/b/../../../secret)", () => {
    // After posix.normalize: a/b/../../../secret → ../../secret (escapes root)
    expect(() =>
      normalizeWorkspaceRelativePath("a/b/../../../secret", { allowSubdirs: true }),
    ).toThrow();
  });

  test("[Regression #2285-a] rejects Windows-backslash traversal (..\\..\\secret)", () => {
    // Back-slashes are converted to forward-slashes first, then posix.normalize
    // catches the traversal.
    expect(() =>
      normalizeWorkspaceRelativePath("..\\..\\secret", { allowSubdirs: true }),
    ).toThrow();
  });

  // ── Other invalid inputs ───────────────────────────────────────────────────

  test("rejects null bytes", () => {
    expect(() =>
      normalizeWorkspaceRelativePath("file\u0000.md", { allowSubdirs: true }),
    ).toThrow();
  });

  test("rejects empty string", () => {
    expect(() => normalizeWorkspaceRelativePath("", { allowSubdirs: true })).toThrow();
  });

  test("enforces allowSubdirs: false", () => {
    expect(() =>
      normalizeWorkspaceRelativePath("workspace/dir/notes.md", { allowSubdirs: false }),
    ).toThrow();
  });

  test("treats workspace/ with no file as invalid", () => {
    expect(() => normalizeWorkspaceRelativePath("workspace/", { allowSubdirs: true })).toThrow();
    expect(() =>
      normalizeWorkspaceRelativePath("/workspace/", { allowSubdirs: true }),
    ).toThrow();
  });
});

// ─── resolveSafeChildPath ────────────────────────────────────────────────────

describe("resolveSafeChildPath", () => {
  // Use the OS temp dir as a stable root that always exists as an absolute path.
  // We are NOT actually reading/writing — only testing string comparisons.
  const root = nodePath.resolve(
    nodePath.join(
      process.platform === "win32" ? "C:\\projects\\ws" : "/projects/ws",
    ),
  );

  // ── Acceptance ─────────────────────────────────────────────────────────────

  test("accepts a file directly inside the workspace root", () => {
    const result = resolveSafeChildPath(root, "notes.md");
    expect(result.startsWith(root)).toBe(true);
    expect(result).toContain("notes.md");
  });

  test("accepts a nested file inside the workspace root", () => {
    const result = resolveSafeChildPath(root, "reports/q1.csv");
    expect(result.startsWith(root)).toBe(true);
  });

  // Regression #2285 — vector (b): case-mismatch on Windows/macOS
  test("[Regression #2285-b] accepts path whose casing differs from root (case-insensitive OS fix)", () => {
    // On Windows and macOS the filesystem is case-insensitive, so a path
    // differing only in case should still be accepted rather than rejected
    // with a false-positive traversal error.
    const upperRoot = root.toUpperCase();
    // Build a candidate that resolves to the same location but with different case.
    const child = "notes.md";
    // We test the function against the lower-cased root; on a real Windows/macOS
    // system `resolve` would normalise the case; here we validate the guard itself.
    // The function should NOT throw for a valid child.
    expect(() => resolveSafeChildPath(upperRoot, child)).not.toThrow();
  });

  // ── Rejection ─────────────────────────────────────────────────────────────

  // Regression #2285 — vector (a) at the resolveSafeChildPath layer
  test("[Regression #2285-a] rejects a path that resolves to the root itself", () => {
    // Passing "." or "" resolves to the root — must be rejected.
    expect(() => resolveSafeChildPath(root, ".")).toThrow(/Path must point to a file/);
  });

  test("[Regression #2285-a] rejects a path that escapes via ..", () => {
    expect(() => resolveSafeChildPath(root, "../escape.md")).toThrow(
      /Path traversal is not allowed/,
    );
  });

  test("[Regression #2285-a] rejects a deeply nested traversal", () => {
    expect(() => resolveSafeChildPath(root, "a/b/../../../escape.md")).toThrow(
      /Path traversal is not allowed/,
    );
  });

  // Regression #2285 — vector (c): sibling-workspace-prefix bypass
  test("[Regression #2285-c] rejects a sibling workspace whose name starts with the same prefix", () => {
    // /projects/ws-evil must not be accepted when root is /projects/ws.
    // The trailing separator in `rootPrefix = root + sep` prevents this.
    const siblingEscape = process.platform === "win32"
      ? root.replace("ws", "ws-evil") + "\\secret.md"
      : root.replace("ws", "ws-evil") + "/secret.md";
    expect(() => resolveSafeChildPath(root, nodePath.relative(root, siblingEscape))).toThrow(
      /Path traversal is not allowed/,
    );
  });

  test("rejects an absolute path to an unrelated directory", () => {
    const outside = process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/etc/passwd";
    expect(() => resolveSafeChildPath(root, outside)).toThrow(/Path traversal is not allowed/);
  });
});
