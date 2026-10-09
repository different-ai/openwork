import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES, isGoogleDriveUploadSessionUrl } from "@openwork/types/google-drive-upload";
import { uploadDriveResumableFile } from "../src/extensions/drive-resumable-upload.js";

const session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-secret";
async function fixture(size = GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES + 17) {
  const root = await mkdtemp(join(tmpdir(), "drive-resume-unit-"));
  const path = join(root, "video.mp4");
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await writeFile(path, bytes);
  return { path, bytes, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}
function sentBytes(init?: RequestInit) {
  assert.ok(init?.body instanceof Uint8Array);
  assert.equal(new Headers(init.headers).has("authorization"), false);
  assert.equal(init.redirect, "manual");
  assert.ok(init.body.byteLength <= GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES);
  return Buffer.from(init.body);
}
function completed() { return Response.json({ id: "completed-file", name: "video.mp4" }); }

test("session URLs cannot redirect authorized file bytes to another destination", () => {
  assert.equal(isGoogleDriveUploadSessionUrl(session), true);
  for (const url of [session.replace("www.googleapis.com", "evil.test"), session.replace("https:", "http:"), session.replace("/upload/drive/v3/files", "/other"), session + "#fragment", session.replace("upload_id=", "other="), session.replace("www.googleapis.com", "user:password@www.googleapis.com")]) assert.equal(isGoogleDriveUploadSessionUrl(url), false, url);
});

test("files larger than 4 MiB arrive byte-for-byte in bounded chunks without credentials", async () => {
  await using file = await fixture();
  const chunks: Buffer[] = [];
  const result = await uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async (url, init) => {
    assert.equal(url, session);
    const bytes = sentBytes(init); chunks.push(bytes);
    const start = chunks.length === 1 ? 0 : GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES;
    assert.equal(new Headers(init?.headers).get("content-range"), `bytes ${start}-${start + bytes.length - 1}/${file.bytes.length}`);
    return chunks.length === 1 ? new Response(null, { status: 308, headers: { range: `bytes=0-${bytes.length - 1}` } }) : completed();
  } });
  assert.equal(chunks.length, 2); assert.deepEqual(Buffer.concat(chunks), file.bytes);
  assert.deepEqual(result, { ok: true, file: { id: "completed-file", name: "video.mp4" } });
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
});

test("a lost acknowledgement queries the same session and does not resend committed bytes", async () => {
  await using file = await fixture();
  const calls: string[] = [];
  const chunks: Buffer[] = [];
  await uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async (url, init) => {
    assert.equal(url, session); const bytes = sentBytes(init);
    calls.push(new Headers(init?.headers).get("content-range") ?? "");
    if (calls.length === 1) { chunks.push(bytes); throw new Error("network error with " + session); }
    if (calls.length === 2) { assert.equal(bytes.length, 0); return new Response(null, { status: 308, headers: { range: `bytes=0-${GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES - 1}` } }); }
    chunks.push(bytes); return completed();
  } });
  assert.equal(calls[1], `bytes */${file.bytes.length}`); assert.equal(calls.length, 3);
  assert.deepEqual(Buffer.concat(chunks), file.bytes);
});

test("a lost final acknowledgement reports completion from the status probe without a new upload", async () => {
  await using file = await fixture(5 * 1024 * 1024);
  let calls = 0;
  const result = await uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async (_, init) => {
    const bytes = sentBytes(init);
    if (++calls === 1) { assert.deepEqual(bytes, file.bytes); return new Response(null, { status: 503 }); }
    assert.equal(bytes.length, 0); return completed();
  } });
  assert.equal(calls, 2); assert.equal(result.file.id, "completed-file");
});

test("failed status probes redact secrets and never silently restart", async () => {
  await using file = await fixture(); let calls = 0;
  await assert.rejects(uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async () => { calls++; throw new Error(session); } }), (error: unknown) => {
    assert.ok(error instanceof Error); assert.match(error.message, /Check Drive/); assert.equal(error.message.includes("synthetic-secret"), false); return true;
  }); assert.equal(calls, 2);
});

test("308 never follows Location and rejects invalid progress", async () => {
  await using file = await fixture();
  for (const range of ["bytes=1-100", "bytes=0-99999999999", "bytes=0-invalid"]) {
    let calls = 0;
    await assert.rejects(uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async (_, init) => { calls++; sentBytes(init); return new Response(null, { status: 308, headers: { range, location: "https://evil.test" } }); } }), /invalid upload progress/);
    assert.equal(calls, 1);
  }
});

test("expired sessions and missing file ids do not claim successful uploads", async () => {
  await using file = await fixture();
  for (const status of [404, 410, 200]) {
    await assert.rejects(uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async () => status === 200 ? Response.json({ ok: true }) : new Response(null, { status }) }), status === 200 ? /no completed file id/ : /expired/);
  }
});

test("changed files and cancellation send no bytes", async () => {
  await using file = await fixture(10);
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const fetch = async () => { calls++; return completed(); };
  await assert.rejects(uploadDriveResumableFile({ path: file.path, size: 11, mimeType: "video/mp4", uploadUrl: session, fetch }), /changed before upload/);
  await assert.rejects(uploadDriveResumableFile({ path: file.path, size: 10, mimeType: "video/mp4", uploadUrl: session, fetch, signal: controller.signal }));
  assert.equal(calls, 0);
});

test("completed receipts omit unexpected fields and reject mismatched sizes", async () => {
  await using file = await fixture(10);
  const base = { path: file.path, size: 10, mimeType: "video/mp4", uploadUrl: session };
  const result = await uploadDriveResumableFile({ ...base, fetch: async () => Response.json({ id: "completed", name: "video.mp4", uploadUrl: session, accessToken: "fixture-private-token" }) });
  assert.deepEqual(result, { ok: true, file: { id: "completed", name: "video.mp4" } });
  await assert.rejects(uploadDriveResumableFile({ ...base, fetch: async () => Response.json({ id: "completed", size: "9" }) }), /unexpected completed file size/);
});

test("partial acknowledgements resume from the actual byte offset, not the attempted chunk end", async () => {
  await using file = await fixture(9 * 1024 * 1024 + 17);
  let committed = 0; let calls = 0; const stored: Buffer[] = [];
  await uploadDriveResumableFile({ path: file.path, size: file.bytes.length, mimeType: "video/mp4", uploadUrl: session, fetch: async (_, init) => {
    const bytes = sentBytes(init);
    assert.equal(new Headers(init?.headers).get("content-range"), `bytes ${committed}-${committed + bytes.length - 1}/${file.bytes.length}`);
    const accepted = ++calls === 1 ? 17 : bytes.length;
    stored.push(bytes.subarray(0, accepted)); committed += accepted;
    return committed === file.bytes.length ? completed() : new Response(null, { status: 308, headers: { range: `bytes=0-${committed - 1}` } });
  } });
  assert.equal(calls, 3); assert.deepEqual(Buffer.concat(stored), file.bytes);
});
