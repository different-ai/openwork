import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openChatWorkspaceFile, resolveChatFilePath } from "./workspace-file-access.mjs";

let root;
let workspace;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openwork-file-open-"));
  workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "notes.md"), "notes");
  await writeFile(path.join(root, "clip.mp4"), "clip");
  await symlink(path.join(root, "clip.mp4"), path.join(workspace, "outside.mp4"));
});
after(async () => { await rm(root, { recursive: true, force: true }); });

test("read-only probe resolves real files with spaces and Unicode and directories", async () => {
  const file = path.join(workspace, "résumé 日本語 notes.md");
  await writeFile(file, "notes");
  assert.equal(await resolveChatFilePath(file), await realpath(file));
  assert.equal(await resolveChatFilePath(workspace), await realpath(workspace));
});

test("read-only probe returns null for missing and invalid candidates", async () => {
  for (const candidate of [
    path.join(workspace, "missing.md"),
    "notes.md",
    "./notes.md",
    "../notes.md",
    "~/notes.md",
    "",
    "file:///workspace/notes.md",
    "//server/share/notes.md",
    "\\\\server\\share\\notes.md",
    "\\\\?\\UNC\\server\\share\\notes.md",
    `${workspace}\u0000notes.md`,
  ]) {
    assert.equal(await resolveChatFilePath(candidate), null, candidate);
  }
});

test("read-only probe canonicalizes file and directory symlinks without granting launch access", async () => {
  const link = path.join(workspace, "outside.mp4");
  assert.equal(await resolveChatFilePath(link), await realpath(path.join(root, "clip.mp4")));
  const directoryLink = path.join(root, "workspace-link");
  await symlink(workspace, directoryLink, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await resolveChatFilePath(directoryLink), await realpath(workspace));
  const native = actions();
  assert.deepEqual(await openChatWorkspaceFile(workspace, link, native), { ok: true, action: "revealed" });
  assert.deepEqual(native.calls, [["reveal", link]]);
});

function actions(reveal = false) {
  const calls = [];
  return {
    calls, reveal,
    openPath: async (file) => { calls.push(["open", file]); return ""; },
    revealPath: (file) => { calls.push(["reveal", file]); },
  };
}

test("opens real workspace files and reveals outside files without launching them", async () => {
  const local = actions();
  assert.deepEqual(await openChatWorkspaceFile(workspace, path.join(workspace, "notes.md"), local), { ok: true, action: "opened" });
  assert.equal(local.calls[0][0], "open");
  const outside = actions();
  assert.deepEqual(await openChatWorkspaceFile(workspace, path.join(root, "clip.mp4"), outside), { ok: true, action: "revealed" });
  assert.equal(outside.calls[0][0], "reveal");
  const link = actions();
  assert.deepEqual(await openChatWorkspaceFile(workspace, path.join(workspace, "outside.mp4"), link), { ok: true, action: "revealed" });
  assert.equal(link.calls[0][0], "reveal");
});

test("reveal checks the file itself instead of opening its existing parent folder", async () => {
  const native = actions(true);
  assert.deepEqual(await openChatWorkspaceFile(workspace, path.join(workspace, "gone.md"), native), { ok: true, action: "unavailable" });
  assert.deepEqual(native.calls, []);
});

test("missing local, remote-shaped and other-user absolute paths return a calm outcome", async () => {
  for (const file of [path.join(root, "gone.mp4"), "/home/runner/missing-eng-963.md", "/workspace/missing-eng-963.md", "/Users/other/missing-eng-963.md"]) {
    const native = actions();
    assert.deepEqual(await openChatWorkspaceFile(workspace, file, native), { ok: true, action: "unavailable" });
    assert.deepEqual(native.calls, []);
  }
});

test("explicit reveal of an existing workspace file does not launch it", async () => {
  const native = actions(true);
  assert.deepEqual(await openChatWorkspaceFile(workspace, path.join(workspace, "notes.md"), native), { ok: true, action: "revealed" });
  assert.equal(native.calls[0][0], "reveal");
});
