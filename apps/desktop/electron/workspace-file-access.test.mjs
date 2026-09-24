import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceFileLaunch } from "./workspace-file-access.mjs";

/** @param {Awaited<ReturnType<typeof resolveWorkspaceFileLaunch>>} decision */
function refusedReason(decision) {
  assert.equal(decision.ok, false);
  return decision.ok === false ? decision.reason : undefined;
}

/** @param {Awaited<ReturnType<typeof resolveWorkspaceFileLaunch>>} decision */
function allowedPath(decision) {
  assert.equal(decision.ok, true);
  return decision.ok === true ? decision.path : undefined;
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "openwork-file-access-"));
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  await mkdir(path.join(workspace, "reports"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, "reports", "Report.pdf"), "inside");
  await writeFile(path.join(outside, "payload.command"), "#!/bin/sh\n");
  await symlink(path.join(outside, "payload.command"), path.join(workspace, "reports", "link.pdf"));
  await symlink(workspace, path.join(base, "workspace-alias"));
  return { base, workspace, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test("a regular file inside the workspace may launch with its resolved path", async () => {
  const fx = await fixture();
  try {
    const decision = await resolveWorkspaceFileLaunch(fx.workspace, path.join(fx.workspace, "reports", "Report.pdf"));
    assert.equal(allowedPath(decision), await realpath(path.join(fx.workspace, "reports", "Report.pdf")));
  } finally {
    await fx.cleanup();
  }
});

test("a workspace symlink that points outside the workspace is refused as outside", async () => {
  const fx = await fixture();
  try {
    const decision = await resolveWorkspaceFileLaunch(fx.workspace, path.join(fx.workspace, "reports", "link.pdf"));
    assert.equal(refusedReason(decision), "outside");
  } finally {
    await fx.cleanup();
  }
});

test("a symlinked workspace root still contains its real files", async () => {
  const fx = await fixture();
  try {
    const alias = path.join(fx.base, "workspace-alias");
    const decision = await resolveWorkspaceFileLaunch(alias, path.join(alias, "reports", "Report.pdf"));
    assert.equal(decision.ok, true);
  } finally {
    await fx.cleanup();
  }
});

test("traversal, directories, missing files and relative input never launch", async () => {
  const fx = await fixture();
  try {
    const traversal = await resolveWorkspaceFileLaunch(fx.workspace, path.join(fx.workspace, "reports", "..", "..", "outside", "payload.command"));
    assert.equal(refusedReason(traversal), "outside");
    const root = await resolveWorkspaceFileLaunch(fx.workspace, fx.workspace);
    assert.equal(refusedReason(root), "outside");
    const directory = await resolveWorkspaceFileLaunch(fx.workspace, path.join(fx.workspace, "reports"));
    assert.equal(refusedReason(directory), "not-file");
    const missing = await resolveWorkspaceFileLaunch(fx.workspace, path.join(fx.workspace, "reports", "Missing.pdf"));
    assert.equal(refusedReason(missing), "missing");
    const relative = await resolveWorkspaceFileLaunch(fx.workspace, "reports/Report.pdf");
    assert.equal(refusedReason(relative), "invalid");
    const empty = await resolveWorkspaceFileLaunch("", path.join(fx.workspace, "reports", "Report.pdf"));
    assert.equal(refusedReason(empty), "invalid");
  } finally {
    await fx.cleanup();
  }
});
