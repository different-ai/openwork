import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callDriveFileAction } from "../src/extensions/drive-files.js";
import type { CloudUploadDependencies } from "../src/extensions/cloud-uploads.js";
import type { DriveFileApprovalRequest, ServerConfig } from "../src/types.js";

const CONTENT = "exported document bytes";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "drive-pull-"));
  const root = join(directory, "workspace");
  await mkdir(root);
  const approvals: DriveFileApprovalRequest[] = [];
  const config: ServerConfig = {
    host: "127.0.0.1", port: 8787, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [], workspaces: [],
    authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false,
    configPath: join(directory, "state", "openwork.json"),
    driveFileApproval: async (request) => { approvals.push(request); return true; },
  };
  const requests: URL[] = [];
  const remote = { revision: "rev-1" };
  const dependencies: CloudUploadDependencies = {
    readCloudMcp: async () => ({ type: "remote", url: "https://cloud.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: "Bearer test-fixture" } }),
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.pathname.endsWith("/content")) return new Response(CONTENT);
      return Response.json({
        file: { id: "doc-1", name: "Project notes", mimeType: "application/vnd.google-apps.document", native: true, revision: remote.revision, webViewLink: "https://docs.google.com/document/d/doc-1/edit?usp=drivesdk&ouid=private" },
        download: { format: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: ".docx", size: null, exported: true },
      });
    },
  };
  return { directory, root, config, approvals, dependencies, requests, remote, [Symbol.asyncDispose]: async () => rm(directory, { recursive: true, force: true }) };
}

for (const path of [undefined, "reports/notes.docx"]) {
  test(`a new Google Doc export to ${path ?? "the default folder"} needs no native approval`, async () => {
    await using workspace = await fixture();
    workspace.config.driveFileApproval = undefined;
    const result = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path, connectionId: "google-workspace" }, { directory: workspace.root }, workspace.dependencies);
    assert.equal(await readFile(join(workspace.root, path ?? "drive/Project notes.docx"), "utf8"), CONTENT);
    assert.equal(result?.ok, true);
    assert.equal(result?.path, path ?? "drive/Project notes.docx");
    assert.ok(workspace.requests.every(url => url.searchParams.get("connectionId") === "google-workspace"));
  });
}

test("an absolute canonical destination inside a symlink-opened workspace is authorized", async () => {
  await using workspace = await fixture();
  const alias = join(workspace.directory, "workspace-link");
  await symlink(workspace.root, alias, "dir");
  workspace.config.authorizedRoots = [alias];
  const path = join(await realpath(workspace.root), "reports", "notes.docx");
  const result = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path }, { directory: alias }, workspace.dependencies);
  assert.equal(await readFile(path, "utf8"), CONTENT);
  assert.equal(result?.path, "reports/notes.docx");
  assert.deepEqual(workspace.approvals, []);
});

test("the calling workspace's canonical subdirectory is used for relative destinations", async () => {
  await using workspace = await fixture();
  const alias = join(workspace.directory, "workspace-link");
  await symlink(workspace.root, alias, "dir");
  await mkdir(join(workspace.root, "project"));
  workspace.config.authorizedRoots = [alias];
  const directory = join(await realpath(workspace.root), "project");
  const result = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: "reports/notes.docx" }, { directory }, workspace.dependencies);
  assert.equal(await readFile(join(directory, "reports/notes.docx"), "utf8"), CONTENT);
  assert.equal(result?.path, "reports/notes.docx");
});

test("a canonical subdirectory's returned path edits, checks and saves the same file, not a root-level namesake", async () => {
  await using workspace = await fixture();
  const alias = join(workspace.directory, "workspace-link");
  await symlink(workspace.root, alias, "dir");
  await mkdir(join(workspace.root, "project"));
  workspace.config.authorizedRoots = [alias];
  const context = { directory: join(await realpath(workspace.root), "project") };
  const path = "reports/notes.docx";
  await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path }, {}, workspace.dependencies);
  const pulled = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path }, context, workspace.dependencies);
  assert.equal(pulled?.path, path);
  await writeFile(join(context.directory, path), "edited project notes");
  const status = await callDriveFileAction(workspace.config, "drive_file_status", { path }, context, workspace.dependencies);
  assert.ok(status && "files" in status);
  assert.equal(status.files[0]?.local, "edited");
  const originalFetch = workspace.dependencies.fetchImpl!;
  let uploaded = "";
  workspace.dependencies.fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/drive-upload-sessions")) {
      return Response.json({ uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture", size: Buffer.byteLength("edited project notes") });
    }
    if (url.hostname === "www.googleapis.com") {
      assert.ok(init?.body instanceof Uint8Array);
      uploaded = Buffer.from(init.body).toString();
      return Response.json({ id: "saved-copy", name: "Project notes (edited)", mimeType: "application/vnd.google-apps.document", version: "rev-2" });
    }
    return originalFetch(input, init);
  };
  const saved = await callDriveFileAction(workspace.config, "drive_push_file", { path }, context, workspace.dependencies);
  assert.equal(saved?.ok, true);
  assert.equal(uploaded, "edited project notes");
  assert.equal(await readFile(join(workspace.root, path), "utf8"), CONTENT);
  assert.equal(workspace.approvals.at(-1)?.path, join(context.directory, path));
  assert.equal(workspace.approvals.at(-1)?.displayPath, path);
  // Canonical absolute paths must resolve to this same file as well.
  await assert.rejects(callDriveFileAction(workspace.config, "drive_push_file", { path: join(context.directory, path), mode: "replace" }, context, workspace.dependencies), /Google Docs, Sheets and Slides files cannot be replaced/);
});

test("a changed remote revision still asks before refreshing an existing clean local copy", async () => {
  await using workspace = await fixture();
  const args = { fileId: "doc-1", path: "notes.docx" };
  await callDriveFileAction(workspace.config, "drive_pull_file", args, {}, workspace.dependencies);
  assert.deepEqual(workspace.approvals, []);
  workspace.remote.revision = "rev-2";
  workspace.config.driveFileApproval = async (request) => { workspace.approvals.push(request); return false; };
  const downloads = workspace.requests.filter(url => url.pathname.endsWith("/content")).length;
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", args, {}, workspace.dependencies), /not approved/);
  assert.equal(workspace.requests.filter(url => url.pathname.endsWith("/content")).length, downloads);
  assert.equal(await readFile(join(workspace.root, "notes.docx"), "utf8"), CONTENT);
  assert.equal(workspace.approvals[0]?.action, "overwrite");
});

test("outside destinations and symlink escapes fail before downloading with a recovery action", async () => {
  await using workspace = await fixture();
  const outside = join(workspace.directory, "outside");
  await mkdir(outside);
  await symlink(outside, join(workspace.root, "escape"), "dir");
  for (const path of [join(outside, "notes.docx"), "../outside/notes.docx", "escape/notes.docx"]) {
    await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path }, { directory: workspace.root }, workspace.dependencies), (error: Error) => {
      assert.match(error.message, /workspace/i);
      assert.match(error.message, /reports\/.*omit.*path/i);
      return true;
    });
  }
  assert.ok(!workspace.requests.some(url => url.pathname.endsWith("/content")));
  assert.deepEqual(workspace.approvals, []);
});

test("replacing an existing local file still requires host confirmation and denial preserves it", async () => {
  await using workspace = await fixture();
  await mkdir(join(workspace.root, "reports"));
  const path = join(workspace.root, "reports", "notes.docx");
  await writeFile(path, "local edits");
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path }, {}, workspace.dependencies), /different file already exists/);
  workspace.config.driveFileApproval = async (request) => { workspace.approvals.push(request); return false; };
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path, overwrite: true }, {}, workspace.dependencies), /not approved/);
  assert.equal(await readFile(path, "utf8"), "local edits");
  assert.equal(workspace.approvals[0]?.action, "overwrite");
  assert.equal(workspace.approvals[0]?.displayPath, "reports/notes.docx");
  assert.ok(!workspace.requests.some(url => url.pathname.endsWith("/content")));
});

test("only authorized roots choose a destination, never untrusted caller context", async () => {
  await using workspace = await fixture();
  const second = join(workspace.directory, "second");
  await mkdir(second);
  workspace.config.authorizedRoots.push(second);
  const selected = await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: "reports/notes.docx" }, { directory: second }, workspace.dependencies);
  assert.equal(selected?.path, "reports/notes.docx");
  assert.equal(await readFile(join(second, "reports/notes.docx"), "utf8"), CONTENT);
  const outside = join(workspace.directory, "untrusted");
  await mkdir(outside);
  await callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: "fallback.docx" }, { directory: outside }, workspace.dependencies);
  assert.equal(await readFile(join(workspace.root, "fallback.docx"), "utf8"), CONTENT);
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: join(outside, "notes.docx") }, { directory: outside }, workspace.dependencies), /workspace-relative path/);
});

test("a folder swapped during download cannot redirect bytes outside the workspace", async () => {
  await using workspace = await fixture();
  const outside = join(workspace.directory, "outside");
  const folder = join(workspace.root, "reports");
  await mkdir(outside);
  await writeFile(join(outside, "notes.docx"), "outside sentinel");
  const originalFetch = workspace.dependencies.fetchImpl!;
  workspace.dependencies.fetchImpl = async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).includes("/content")) {
      await rename(folder, `${folder}-original`);
      await symlink(outside, folder, "dir");
    }
    return response;
  };
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: "reports/notes.docx" }, {}, workspace.dependencies), /changed while pulling/);
  assert.equal(await readFile(join(outside, "notes.docx"), "utf8"), "outside sentinel");
  assert.deepEqual(workspace.approvals, []);
});

test("overwrites without a host callback fail closed even if args claim approval", async () => {
  await using workspace = await fixture();
  await writeFile(join(workspace.root, "notes.docx"), "local edits");
  workspace.config.driveFileApproval = undefined;
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: "notes.docx", overwrite: true, approved: true }, {}, workspace.dependencies), /Desktop must confirm/);
  assert.equal(await readFile(join(workspace.root, "notes.docx"), "utf8"), "local edits");
  assert.ok(!workspace.requests.some(url => url.pathname.endsWith("/content")));
});

test("an existing destination symlink is never overwritten", async () => {
  await using workspace = await fixture();
  const outside = join(workspace.directory, "outside.docx");
  await writeFile(outside, "keep");
  await symlink(outside, join(workspace.root, "notes.docx"));
  await assert.rejects(callDriveFileAction(workspace.config, "drive_pull_file", { fileId: "doc-1", path: "notes.docx", overwrite: true }, {}, workspace.dependencies), /not a regular file/);
  assert.equal(await readFile(outside, "utf8"), "keep");
  assert.deepEqual(workspace.approvals, []);
});
