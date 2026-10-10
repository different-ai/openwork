import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { callOpenWorkCloudUploadAction, type CloudUploadDependencies } from "../src/extensions/cloud-uploads.js";
import type { ServerConfig } from "../src/types.js";

const session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-secret";
const connectionId = "emc_SelectedFixture";
async function fixture(size = 32) {
  const root = await mkdtemp(join(tmpdir(), "cloud-drive-unit-"));
  const bytes = Buffer.alloc(size, 123); await writeFile(join(root, "video.mp4"), bytes);
  const config: ServerConfig = { host: "127.0.0.1", port: 8787, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 30_000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "pretty", logRequests: false };
  return { config, root, bytes, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}
const cloud: CloudUploadDependencies["readCloudMcp"] = async () => ({ type: "remote", url: "https://cloud.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: "Bearer cloud-member-fixture" } });

test("small Drive uploads preserve selected identity, exact bytes and folder metadata", async () => {
  await using file = await fixture();
  let calls = 0;
  await callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path: "video.mp4", connectionId, folderId: "selected-folder" }, {}, { readCloudMcp: cloud, fetchImpl: async (url, init) => {
    calls++; assert.equal(url, "https://cloud.test/v1/direct-uploads/google-workspace/drive-files");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cloud-member-fixture");
    assert.ok(init?.body instanceof FormData);
    assert.equal(init.body.get("connectionId"), connectionId); assert.equal(init.body.get("folderId"), "selected-folder");
    const upload = init.body.get("file"); assert.ok(upload instanceof File);
    assert.equal(upload.name, "video.mp4"); assert.deepEqual(Buffer.from(await upload.arrayBuffer()), file.bytes);
    return Response.json({ ok: true, file: { id: "small-file" } });
  } }); assert.equal(calls, 1);
});

test("large Drive uploads keep file bytes and Google sessions out of Cloud and tool results", async () => {
  await using file = await fixture(5 * 1024 * 1024);
  const urls: string[] = [];
  const result = await callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path: "video.mp4", connectionId, folderId: "selected-folder" }, {}, { readCloudMcp: cloud, fetchImpl: async (url, init) => {
    urls.push(url);
    if (urls.length === 1) {
      assert.equal(url, "https://cloud.test/v1/direct-uploads/google-workspace/drive-upload-sessions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer cloud-member-fixture");
      assert.equal(typeof init?.body, "string");
      assert.deepEqual(JSON.parse(String(init?.body)), { name: "video.mp4", size: file.bytes.length, mimeType: "video/mp4", folderId: "selected-folder", connectionId });
      return Response.json({ ok: true, uploadUrl: session, size: file.bytes.length });
    }
    assert.equal(url, session); assert.equal(new Headers(init?.headers).has("authorization"), false);
    assert.ok(init?.body instanceof Uint8Array); assert.deepEqual(Buffer.from(init.body), file.bytes);
    return Response.json({ id: "large-file", name: "video.mp4" });
  } });
  assert.deepEqual(result, { ok: true, file: { id: "large-file", name: "video.mp4" } });
  assert.equal(urls.length, 2); assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
});

test("a disabled resumable route never falls back to a multipart upload or another account", async () => {
  await using file = await fixture(5 * 1024 * 1024); let calls = 0;
  await assert.rejects(callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path: "video.mp4", connectionId }, {}, { readCloudMcp: cloud, fetchImpl: async () => { calls++; return Response.json({ error: "feature_disabled" }, { status: 404 }); } }), /not enabled/);
  assert.equal(calls, 1);
});

test("invalid or unavailable selected connections never default silently", async () => {
  await using file = await fixture(); let calls = 0;
  const dependencies: CloudUploadDependencies = { readCloudMcp: cloud, fetchImpl: async () => { calls++; return Response.json({ error: "needs_connection", message: "Selected account is unavailable." }, { status: 409 }); } };
  for (const connectionId of ["", "another-provider", 42]) await assert.rejects(callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path: "video.mp4", connectionId }, {}, dependencies), /connectionId/);
  assert.equal(calls, 0);
  await assert.rejects(callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path: "video.mp4", connectionId }, {}, dependencies), /Selected account is unavailable/);
  assert.equal(calls, 1);
});

test("unsafe paths and malicious session URLs cannot send file bytes", async () => {
  await using file = await fixture(5 * 1024 * 1024); let calls = 0;
  await symlink("/etc/passwd", join(file.root, "escape"));
  const dependencies: CloudUploadDependencies = { readCloudMcp: cloud, fetchImpl: async () => { calls++; return Response.json({ ok: true, size: file.bytes.length, uploadUrl: "https://evil.test/collect" }); } };
  for (const path of ["../outside", "escape"]) await assert.rejects(callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path }, {}, dependencies), /authorized workspace root/);
  assert.equal(calls, 0);
  await assert.rejects(callOpenWorkCloudUploadAction(file.config, "drive_upload_file", { path: "video.mp4" }, {}, dependencies), /not a Google Drive session/);
  assert.equal(calls, 1);
});
