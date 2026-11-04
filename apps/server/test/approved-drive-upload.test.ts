import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openWorkspaceFileForReading } from "../src/workspace-file-identity.js";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachApprovedDriveUpload, prepareDriveUploadFile, takeApprovedDriveUpload } from "../src/extensions/approved-drive-upload.js";
import { callOpenWorkCloudUploadAction, type CloudUploadDependencies } from "../src/extensions/cloud-uploads.js";
import type { ServerConfig } from "../src/types.js";

async function fixture(size = 32) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "approved-drive-")));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const path = join(root, "outside.mp4");
  const bytes = Buffer.alloc(size, 123);
  await writeFile(path, bytes);
  const config: ServerConfig = { host: "127.0.0.1", port: 8787, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [], workspaces: [], authorizedRoots: [workspace], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  return { config, root, workspace, path, bytes, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}
const cloud: CloudUploadDependencies["readCloudMcp"] = async () => ({ type: "remote", url: "https://cloud.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: "Bearer synthetic-member" } });

test("an exact-file grant uploads outside roots without authorizing its folder, is single-use and bound to the destination", async () => {
  await using f = await fixture();
  const args = { path: f.path, folderId: "selected-folder", connectionId: "emc_SelectedFixture" };
  const prepared = await prepareDriveUploadFile(f.config, args, {});
  let sent = 0;
  const dependencies: CloudUploadDependencies = { readCloudMcp: cloud, approvedDriveFile: prepared, fetchImpl: async (_url, init) => {
    sent++;
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("connectionId"), args.connectionId);
    assert.equal(init.body.get("folderId"), args.folderId);
    const file = init.body.get("file"); assert.ok(file instanceof File);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), f.bytes);
    return Response.json({ ok: true, file: { id: "approved-file" } });
  } };
  try {
    for (const change of [{ path: join(f.root, "sibling.mp4") }, { folderId: "other-folder" }, { connectionId: "google-workspace" }]) {
      await assert.rejects(callOpenWorkCloudUploadAction(f.config, "drive_upload_file", { ...args, ...change }, {}, dependencies), /only for the selected file and Drive destination/);
    }
    assert.equal(sent, 0);
    assert.deepEqual(await callOpenWorkCloudUploadAction(f.config, "drive_upload_file", args, {}, dependencies), { ok: true, file: { id: "approved-file" } });
    await assert.rejects(callOpenWorkCloudUploadAction(f.config, "drive_upload_file", args, {}, dependencies), /only for the selected file/);
    assert.equal(sent, 1);
    assert.deepEqual(f.config.authorizedRoots, [f.workspace]);
  } finally { await prepared.close(); }
});

test("session identity is stable for an unchanged file and changes after an edit", async () => {
  await using f = await fixture();
  const identities: string[] = [];
  for (let index = 0; index < 3; index++) {
    if (index === 2) await writeFile(f.path, Buffer.alloc(f.bytes.length + 1, 99));
    const file = await prepareDriveUploadFile(f.config, { path: f.path }, {});
    try { identities.push(file.approvalIdentity()); } finally { await file.close(); }
  }
  assert.equal(identities[0], identities[1]);
  assert.notEqual(identities[1], identities[2]);
});

test("ordinary requests cannot forge file approval through JSON, even with a cloned request or an absolute path", async () => {
  await using f = await fixture();
  const prepared = await prepareDriveUploadFile(f.config, { path: f.path }, {});
  const request = new Request("http://localhost/experimental/extensions/call", { method: "POST", body: "{}" });
  try {
    attachApprovedDriveUpload(request, prepared);
    assert.equal(takeApprovedDriveUpload(request.clone()), undefined);
    assert.equal(takeApprovedDriveUpload(request), prepared);
    assert.equal(takeApprovedDriveUpload(request), undefined);
    const dependencies: CloudUploadDependencies = { readCloudMcp: cloud, fetchImpl: async () => { assert.fail("must not dispatch"); } };
    await assert.rejects(callOpenWorkCloudUploadAction(f.config, "drive_upload_file", { path: f.path, approved: true }, { approvedDriveFile: prepared, approvedPaths: [f.path] }, dependencies), /authorized workspace root/);
    await assert.rejects(prepareDriveUploadFile(f.config, { path: "../outside.mp4" }, { directory: f.workspace }), /authorized workspace root/);
  } finally { await prepared.close(); }
});

test("preflight refuses missing, empty, directory and read-only files without reading bytes", async () => {
  await using f = await fixture();
  await writeFile(join(f.root, "empty"), "");
  for (const path of [join(f.root, "missing"), join(f.root, "empty"), f.root]) {
    await assert.rejects(prepareDriveUploadFile(f.config, { path }, {}));
  }
  await assert.rejects(prepareDriveUploadFile({ ...f.config, readOnly: true }, { path: f.path }, {}), /read-only/);
});

test("named pipes are rejected without waiting for a writer, including by the post-open proof", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  await using f = await fixture();
  const pipe = join(f.root, "pipe");
  await promisify(execFile)("mkfifo", [pipe]);
  await assert.rejects(prepareDriveUploadFile(f.config, { path: pipe }, {}), /not a regular file/);
  await assert.rejects(openWorkspaceFileForReading(f.root, pipe, "The upload file"), /not a regular file/);
});

test("replacement, symlink swap and same-size edits during approval never dispatch file bytes", async () => {
  for (const change of ["replace", "symlink", "edit"]) {
    await using f = await fixture();
    const prepared = await prepareDriveUploadFile(f.config, { path: f.path }, {});
    try {
      if (change === "edit") await writeFile(f.path, Buffer.alloc(f.bytes.length, 99));
      else {
        await rename(f.path, join(f.root, "original"));
        if (change === "symlink") await symlink(join(f.root, "original"), f.path);
        else await writeFile(f.path, f.bytes);
      }
      await assert.rejects(callOpenWorkCloudUploadAction(f.config, "drive_upload_file", prepared.args, {}, {
        readCloudMcp: cloud, approvedDriveFile: prepared, fetchImpl: async () => { assert.fail("must not dispatch"); },
      }), /changed while awaiting upload approval/);
    } finally { await prepared.close(); }
  }
});

test("preflight resolves a symlink to the canonical file shown for approval and reads that handle for resumable uploads", async () => {
  await using f = await fixture(5 * 1024 * 1024);
  const link = join(f.root, "link.mp4");
  await symlink(f.path, link);
  const prepared = await prepareDriveUploadFile(f.config, { path: link }, {});
  assert.equal(prepared.args.path, f.path);
  let sent = 0;
  try {
    const result = await callOpenWorkCloudUploadAction(f.config, "drive_upload_file", prepared.args, {}, {
      readCloudMcp: cloud, approvedDriveFile: prepared, fetchImpl: async (_url, init) => {
        sent++;
        if (sent === 1) return Response.json({ ok: true, size: f.bytes.length, uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic" });
        assert.ok(init?.body instanceof Uint8Array);
        assert.deepEqual(Buffer.from(init.body), f.bytes);
        return Response.json({ id: "large-approved-file" });
      },
    });
    assert.deepEqual(result, { ok: true, file: { id: "large-approved-file" } });
    assert.equal(sent, 2);
  } finally { await prepared.close(); }
});
