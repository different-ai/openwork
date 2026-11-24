import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveChatFilePath, openChatWorkspaceFile } from "../../desktop/electron/workspace-file-access.mjs";
import { contextualizeFileTarget } from "../src/react-app/domains/session/artifacts/path-reference-context";
import { openTargetFromLocalPath, planFileOpen } from "../src/react-app/domains/session/artifacts/resolve-open-target";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("the benchmark handoff resolves a real home-folder video outside the workspace and only reveals it", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "openwork-chat-home-"));
  temporary.push(homeDir);
  const workspaceRoot = join(homeDir, "workspace");
  const directory = join(homeDir, "Desktop", "OpenWork open-model benchmark");
  await mkdir(workspaceRoot);
  await mkdir(directory, { recursive: true });
  const name = "open-model-benchmark-full.mp4";
  const file = join(directory, name);
  await writeFile(file, "video fixture");
  await writeFile(join(workspaceRoot, name), "decoy");
  const reference = openTargetFromLocalPath(name);
  expect(reference).not.toBeNull();
  if (!reference) throw new Error("Expected a file reference");
  const target = contextualizeFileTarget(reference, "~/Desktop/OpenWork open-model benchmark/");
  const plan = await planFileOpen(target, {
    origin: "local", workspaceRoot, homeDir, canOpenLocally: true,
    findInWorkspace: async () => null,
    findOnComputer: resolveChatFilePath,
  });
  expect(plan).toMatchObject({ kind: "native", action: "reveal", path: await resolveChatFilePath(file) });
  if (plan.kind !== "native") throw new Error("Expected a native reveal");
  const revealed: string[] = [];
  const launched: string[] = [];
  expect(await openChatWorkspaceFile(workspaceRoot, plan.path, {
    reveal: plan.action === "reveal",
    openPath: async (path: string) => { launched.push(path); return ""; },
    revealPath: (path: string) => { revealed.push(path); },
  })).toEqual({ ok: true, action: "revealed" });
  expect(revealed).toEqual([await resolveChatFilePath(file)]);
  expect(launched).toEqual([]);

  await rm(file);
  // A stale resolved identity must not switch to the decoy or its parent.
  const deleted = await planFileOpen({ ...target, resolvedPath: plan.path, exists: true }, {
    origin: "local", workspaceRoot, homeDir, canOpenLocally: true,
    findInWorkspace: async () => null, findOnComputer: resolveChatFilePath,
  });
  expect(deleted.kind).toBe("unavailable");
});
