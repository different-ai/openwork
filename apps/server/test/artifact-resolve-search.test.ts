import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findWorkspaceFileBySuffix, resolveScopedWorkspaceFilePath, resolveWorkspaceArtifactTargets } from "../src/routes/files.js";

let base = "";
let workspace = "";
let home = "";

async function duplicateRoots(name: string) {
  const root = join(base, name, "workspace");
  const conversation = join(base, name, "conversation");
  await touch(root, "src/report.md");
  await touch(conversation, "src/report.md");
  await writeFile(join(root, "src/report.md"), "workspace contents");
  await writeFile(join(conversation, "src/report.md"), "conversation contents");
  return { root, conversation, conversationDirectory: async () => conversation };
}

async function touch(root: string, path: string) {
  const file = join(root, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, "x");
}

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "openwork-artifact-search-"));
  home = join(base, "home");
  workspace = join(home, "openwork-repo");
  await touch(workspace, "apps/desktop/electron/computer-control.test.mjs");
  await touch(workspace, "apps/desktop/electron/main.mjs");
  await touch(workspace, "apps/server/src/main.mjs");
  await touch(workspace, "README.md");
  await touch(workspace, "node_modules/pkg/only-in-deps.mjs");
  await touch(workspace, "dist/only-in-build.mjs");
  await touch(workspace, "docs/deep/a/b/c/notes.md");
  await touch(workspace, "notes.md");
  await touch(home, "Downloads/openwork-launch-edit.mp4");
});

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

const fileTarget = (value: string) => ({ kind: "file", value, confidence: 95, reason: "artifact" });

describe("findWorkspaceFileBySuffix", () => {
  test("finds a bare name anywhere in the workspace", async () => {
    expect(await findWorkspaceFileBySuffix(workspace, "computer-control.test.mjs")).toBe("apps/desktop/electron/computer-control.test.mjs");
  });

  test("prefers the shallowest match, then path order", async () => {
    expect(await findWorkspaceFileBySuffix(workspace, "notes.md")).toBe("notes.md");
    expect(await findWorkspaceFileBySuffix(workspace, "main.mjs")).toBe("apps/desktop/electron/main.mjs");
  });

  test("uses the folders a partial path names", async () => {
    expect(await findWorkspaceFileBySuffix(workspace, "server/src/main.mjs")).toBe("apps/server/src/main.mjs");
    expect(await findWorkspaceFileBySuffix(workspace, "nowhere/main.mjs")).toBeNull();
  });

  test("skips dependency and build folders and stops at its budget", async () => {
    expect(await findWorkspaceFileBySuffix(workspace, "only-in-deps.mjs")).toBeNull();
    expect(await findWorkspaceFileBySuffix(workspace, "only-in-build.mjs")).toBeNull();
    expect(await findWorkspaceFileBySuffix(workspace, "computer-control.test.mjs", { maxDirectories: 2 })).toBeNull();
    expect(await findWorkspaceFileBySuffix(workspace, "computer-control.test.mjs", { maxDepth: 1 })).toBeNull();
  });
});

describe("resolveWorkspaceArtifactTargets", () => {
  test("only searches by name when a click asks for it", async () => {
    const [plain] = await resolveWorkspaceArtifactTargets(workspace, [fileTarget("computer-control.test.mjs")]);
    expect(plain).toMatchObject({ value: "computer-control.test.mjs", exists: false });

    const [searched] = await resolveWorkspaceArtifactTargets(workspace, [fileTarget("computer-control.test.mjs")], { search: true });
    expect(searched).toMatchObject({
      value: "apps/desktop/electron/computer-control.test.mjs",
      name: "computer-control.test.mjs",
      preview: "code",
      exists: true,
    });
  });

  test("keeps a path that exists as written", async () => {
    const [item] = await resolveWorkspaceArtifactTargets(workspace, [fileTarget("README.md")], { search: true });
    expect(item).toMatchObject({ value: "README.md", exists: true });
  });

  test("expands ~/ and accepts it only inside the workspace", async () => {
    const [inside] = await resolveWorkspaceArtifactTargets(workspace, [fileTarget("~/openwork-repo/README.md")], { homeDir: home });
    expect(inside).toMatchObject({ value: "README.md", exists: true });

    const outside = await resolveWorkspaceArtifactTargets(workspace, [fileTarget("~/Downloads/openwork-launch-edit.mp4")], { homeDir: home, search: true });
    expect(outside).toEqual([]);

    expect(await resolveWorkspaceArtifactTargets(workspace, [fileTarget("~someone/notes.md")], { homeDir: home, search: true })).toEqual([]);
  });

  test("absolute references preserve the exact owning root for duplicate relative paths", async () => {
    const { root, conversation, conversationDirectory } = await duplicateRoots("absolute-identity");
    const items = await resolveWorkspaceArtifactTargets(root, [
      fileTarget(join(root, "src/report.md")),
      fileTarget(join(conversation, "src/report.md")),
    ], { conversationDirectory, search: true });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ value: "src/report.md", resolvedPath: join(root, "src/report.md"), fileScope: "workspace", exists: true });
    expect(items[1]).toMatchObject({ value: "src/report.md", resolvedPath: join(conversation, "src/report.md"), fileScope: "conversation", exists: true });
  });

  test("a missing absolute conversation reference never falls back to the workspace copy", async () => {
    const { root, conversation, conversationDirectory } = await duplicateRoots("missing-absolute");
    await rm(join(conversation, "src/report.md"));
    const [item] = await resolveWorkspaceArtifactTargets(root, [fileTarget(join(conversation, "src/report.md"))], { conversationDirectory, search: true });
    expect(item).toMatchObject({ value: "src/report.md", resolvedPath: join(conversation, "src/report.md"), fileScope: "conversation", exists: false });
  });

  test("absolute references prefer the nested conversation root", async () => {
    const root = join(base, "nested-conversation");
    const conversation = join(root, ".worktrees/task");
    await touch(root, "src/report.md");
    await touch(conversation, "src/report.md");
    const [item] = await resolveWorkspaceArtifactTargets(root, [fileTarget(join(conversation, "src/report.md"))], { conversationDirectory: async () => conversation });
    expect(item).toMatchObject({ value: "src/report.md", resolvedPath: join(conversation, "src/report.md"), fileScope: "conversation", exists: true });
  });

  test("a conversation suffix match keeps its scope despite a workspace duplicate", async () => {
    const { root, conversation, conversationDirectory } = await duplicateRoots("suffix-identity");
    const [item] = await resolveWorkspaceArtifactTargets(root, [fileTarget("report.md")], { conversationDirectory, search: true });
    expect(item).toMatchObject({ value: "src/report.md", resolvedPath: join(conversation, "src/report.md"), fileScope: "conversation", exists: true });
    const [revalidated] = await resolveWorkspaceArtifactTargets(root, [item], { conversationDirectory, search: true });
    expect(revalidated).toEqual(item);
    const path = await resolveScopedWorkspaceFilePath(root, "src/report.md", { conversationDirectory, fileScope: "conversation" });
    expect(await readFile(path, "utf8")).toBe("conversation contents");
    await writeFile(path, "edited conversation");
    expect(await readFile(join(conversation, "src/report.md"), "utf8")).toBe("edited conversation");
    expect(await readFile(join(root, "src/report.md"), "utf8")).toBe("workspace contents");
  });

  test("stale scoped targets neither change root nor search for a replacement", async () => {
    const { root, conversation, conversationDirectory } = await duplicateRoots("stale-identity");
    await rm(join(conversation, "src/report.md"));
    await touch(conversation, "elsewhere/src/report.md");
    const [item] = await resolveWorkspaceArtifactTargets(root, [{ ...fileTarget("src/report.md"), fileScope: "conversation" }], { conversationDirectory, search: true });
    expect(item).toMatchObject({ value: "src/report.md", resolvedPath: join(conversation, "src/report.md"), fileScope: "conversation", exists: false });
    expect(await resolveScopedWorkspaceFilePath(root, "src/report.md", { conversationDirectory, fileScope: "conversation" })).toBe(join(conversation, "src/report.md"));

    await touch(conversation, "src/report.md");
    await rm(join(root, "src/report.md"));
    const [workspaceItem] = await resolveWorkspaceArtifactTargets(root, [{ ...fileTarget("src/report.md"), fileScope: "workspace" }], { conversationDirectory, search: true });
    expect(workspaceItem).toMatchObject({ resolvedPath: join(root, "src/report.md"), fileScope: "workspace", exists: false });
    expect(await resolveScopedWorkspaceFilePath(root, "src/report.md", { conversationDirectory, fileScope: "workspace" })).toBe(join(root, "src/report.md"));
  });

  test("scoped conversation access fails closed without a conversation folder", async () => {
    const { root } = await duplicateRoots("missing-conversation");
    expect(await resolveWorkspaceArtifactTargets(root, [{ ...fileTarget("src/report.md"), fileScope: "conversation" }], { search: true })).toEqual([]);
    await expect(resolveScopedWorkspaceFilePath(root, "src/report.md", { fileScope: "conversation" })).rejects.toThrow("Conversation folder is no longer available");
    await expect(resolveScopedWorkspaceFilePath(root, "src/report.md", { fileScope: "invalid" })).rejects.toThrow("fileScope must be workspace or conversation");
  });

  test("absolute scoped references never change their owning root", async () => {
    const { root, conversation, conversationDirectory } = await duplicateRoots("absolute-scope");
    expect(await resolveWorkspaceArtifactTargets(root, [
      { ...fileTarget(join(conversation, "src/report.md")), fileScope: "workspace" },
      { ...fileTarget(join(root, "src/report.md")), fileScope: "conversation" },
    ], { conversationDirectory, search: true })).toEqual([]);
  });

  test("unscoped relative operations retain workspace-first compatibility", async () => {
    const { root, conversation, conversationDirectory } = await duplicateRoots("legacy-fallback");
    expect(await resolveScopedWorkspaceFilePath(root, "src/report.md", { conversationDirectory })).toBe(join(root, "src/report.md"));
    await rm(join(root, "src/report.md"));
    expect(await resolveScopedWorkspaceFilePath(root, "src/report.md", { conversationDirectory })).toBe(join(conversation, "src/report.md"));
  });

  test("never searches for paths that leave the workspace", async () => {
    expect(await resolveWorkspaceArtifactTargets(workspace, [fileTarget("../Downloads/openwork-launch-edit.mp4")], { search: true })).toEqual([]);
    expect(await resolveWorkspaceArtifactTargets(workspace, [fileTarget(join(home, "Downloads/openwork-launch-edit.mp4"))], { search: true })).toEqual([]);
  });
});
