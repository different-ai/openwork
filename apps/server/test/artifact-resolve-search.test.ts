import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findWorkspaceFileBySuffix, resolveWorkspaceArtifactTargets } from "../src/routes/files.js";

let base = "";
let workspace = "";
let home = "";

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

  test("never searches for paths that leave the workspace", async () => {
    expect(await resolveWorkspaceArtifactTargets(workspace, [fileTarget("../Downloads/openwork-launch-edit.mp4")], { search: true })).toEqual([]);
    expect(await resolveWorkspaceArtifactTargets(workspace, [fileTarget(join(home, "Downloads/openwork-launch-edit.mp4"))], { search: true })).toEqual([]);
  });
});
