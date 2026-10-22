import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveWorkspaceFileLaunch } from "../electron/workspace-file-access.mjs";

// Execute the actual IPC handler, not a copied decision function. Inject only
// inert OS shell effects so this test never opens a window or launches a file.
async function actualRevealHandler(shell) {
  const source = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
  const start = source.indexOf('"__revealItemInDir": async');
  const end = source.indexOf('\n  "__applyBrandAppName":', start);
  assert.ok(start >= 0 && end > start, "the shipping reveal handler is present");
  const expression = source.slice(source.indexOf("async", start), end).trim().replace(/,$/, "");
  return vm.runInNewContext(`(${expression})`, { shell, existsSync, path });
}

test("the actual reveal IPC handler never launches an application, executable or symlink parent of a missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "file-reveal-safety-"));
  const launches = [];
  const reveals = [];
  const handler = await actualRevealHandler({
    openPath: async target => { launches.push(target); return ""; },
    showItemInFolder: target => { reveals.push(target); },
  });
  try {
    const app = join(root, "Helper.app");
    const executable = join(root, "helper");
    const appLink = join(root, "helper-link");
    const folder = join(root, "folder");
    const file = join(root, "report.pdf");
    await mkdir(app);
    await mkdir(folder);
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(file, "%PDF-1.7\n");
    await symlink(app, appLink);
    for (const parent of [app, executable, appLink, folder]) {
      const missing = join(parent, "missing.pdf");
      assert.equal(await handler(null, missing), undefined);
      assert.deepEqual(launches, [], "revealing a missing file must never launch its parent");
      assert.equal(reveals.at(-1), parent);
    }
    assert.equal(await handler(null, file), undefined);
    assert.equal(reveals.at(-1), file);
    assert.deepEqual(launches, []);
    assert.match(await handler(null, join(root, "absent", "missing.pdf")), /Could not find/);
    assert.deepEqual(launches, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native file launching uses real files and real workspace containment", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-file-safety-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const inside = join(workspace, "report.pdf");
  const outside = join(root, "outside.pdf");
  await writeFile(inside, "%PDF-1.7\n");
  await writeFile(outside, "%PDF-1.7\n");
  try {
    const existing = await resolveWorkspaceFileLaunch(workspace, inside);
    assert.equal(existing.ok, true);
    assert.equal((await resolveWorkspaceFileLaunch(workspace, join(workspace, "missing.pdf"))).reason, "missing");
    assert.equal((await resolveWorkspaceFileLaunch(workspace, outside)).reason, "outside");
    assert.equal((await resolveWorkspaceFileLaunch(workspace, workspace)).reason, "outside");
    await mkdir(join(workspace, "folder"));
    assert.equal((await resolveWorkspaceFileLaunch(workspace, join(workspace, "folder"))).reason, "not-file");
    const escaping = join(workspace, "escape.pdf");
    await symlink(outside, escaping);
    assert.equal((await resolveWorkspaceFileLaunch(workspace, escaping)).reason, "outside");
    const internal = join(workspace, "internal.pdf");
    await symlink(inside, internal);
    assert.equal((await resolveWorkspaceFileLaunch(workspace, internal)).ok, true);
    const linkedRoot = join(root, "linked-workspace");
    await symlink(workspace, linkedRoot);
    assert.equal((await resolveWorkspaceFileLaunch(linkedRoot, join(linkedRoot, "report.pdf"))).ok, true);
    if (process.platform !== "win32") {
      assert.equal((await resolveWorkspaceFileLaunch("C:\\workspace", "C:\\workspace\\report.pdf")).reason, "invalid");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
