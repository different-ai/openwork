import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { z } from "zod";
import { GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES } from "@openwork/types/google-drive-upload";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import { callOpenWorkCloudUploadAction } from "../src/extensions/cloud-uploads.js";
import * as approvedUploads from "../src/extensions/approved-drive-upload.js";
import type { ServerConfig } from "../src/types.js";
import { fakeEngine } from "./fixtures/drive-approval-engine.js";

async function fixture(size = 32) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "drive-duration-")));
  const path = join(root, "archive.zip");
  await writeFile(path, Buffer.alloc(size, 123));
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "client", hostToken: "host", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
  return { root, path, config, [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }) };
}
const callSchema = z.object({ action: z.string(), args: z.record(z.string(), z.unknown()), context: z.record(z.string(), z.unknown()) });

// Intentionally real wall-clock time: AbortSignal.timeout is a native timer.
// Three progressing 45-second Google chunks must outlive the old 130s cap,
// while every individual network call stays inside its 120-second budget.
test("an approved resumable Drive upload progresses beyond 130 seconds without being cancelled", { timeout: 165_000 }, async () => {
  const size = 2 * GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES + 17;
  await using f = await fixture(size);
  const engine = await fakeEngine({ effect: "ask", reply: "once" });
  let committed = 0;
  let chunks = 0;
  let preparations = 0;
  const startedAt = Date.now();
  const bridge = await createV2ContextBridge(async (path, init) => {
    assert.equal(path, "/experimental/extensions/call");
    const call = callSchema.parse(JSON.parse(String(init?.body)));
    return callOpenWorkCloudUploadAction(f.config, call.action, call.args, call.context, {
      signal: init?.signal ?? undefined,
      readCloudMcp: async () => ({ type: "remote", url: "https://cloud.test/mcp/agent", enabled: true, oauth: false, headers: { Authorization: "Bearer synthetic" } }),
      fetchImpl: async (_url, request) => {
        if (typeof request?.body === "string") {
          preparations++;
          return Response.json({ size, uploadUrl: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=synthetic-duration" });
        }
        assert.ok(request?.body instanceof Uint8Array);
        await delay(45_000, undefined, { signal: request.signal ?? undefined });
        committed += request.body.byteLength;
        chunks++;
        return committed === size ? Response.json({ id: "long-upload", size: String(size) }) : new Response(null, { status: 308, headers: { range: `bytes=0-${committed - 1}` } });
      },
    });
  }, () => engine.connection);
  try {
    const response = await fetch(bridge.url, { method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(160_000),
      body: JSON.stringify({ name: "openwork_drive_upload", input: { path: f.path, connectionId: "google-workspace" }, sessionId: "ses_one", caller: { directory: f.root, messageId: "msg_one", callId: "call_one" } }),
    });
    const body: unknown = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(body, { ok: true, file: { id: "long-upload", size: String(size) } });
    assert.ok(Date.now() - startedAt > 130_000);
    assert.equal(chunks, 3);
    assert.equal(preparations, 1, "never restart an uncertain upload as another file");
    assert.equal(committed, size);
    console.log(`Verified ${chunks} progressing chunks in ${Date.now() - startedAt}ms; one upload session, all bytes confirmed.`);
  } finally { await bridge.close(); await engine.close(); }
});

test("the production prepared-upload dispatcher preserves the caller Stop signal without adding a total deadline", async () => {
  await using f = await fixture();
  const stop = new AbortController();
  let calls = 0;
  const prepare = approvedUploads.createDriveUploadPreflight(f.config, async (path, init, file) => {
    assert.equal(path, "/experimental/extensions/call");
    assert.equal(init.signal, stop.signal);
    assert.equal(file.args.path, f.path);
    calls++;
    return { ok: true };
  });
  const prepared = await prepare({ path: f.path }, { directory: f.root }, stop.signal);
  try {
    assert.deepEqual(await prepared.upload(), { ok: true });
    stop.abort();
    await assert.rejects(async () => prepared.upload());
    assert.equal(calls, 1, "Stop prevents another dispatch");
  } finally { await prepared.close(); }
});
