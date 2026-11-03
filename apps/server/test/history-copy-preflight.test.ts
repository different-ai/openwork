import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { estimateHistoryCopyOffMain, HISTORY_PREFLIGHT_FAILED } from "../src/history-copy-preflight.js";
import { estimateHistoryCopyBytes, preflightHistoryCopy } from "../src/opencode-v2-migration.js";
import { openHistoryDatabase } from "../src/opencode-v2-history-store.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "preflight-unit-"));
  const request = { source: join(directory, "source.db"), storageDir: join(directory, "storage"), targetDatabase: join(directory, "target.db") };
  const staging = join(request.storageDir, "history-copy");
  await mkdir(join(staging, "converted"), { recursive: true });
  const original = join(staging, "source.db");
  const converted = join(staging, "converted", "opencode.db");
  const db = await openHistoryDatabase(original);
  db.exec("CREATE TABLE message(id TEXT PRIMARY KEY, data TEXT); CREATE TABLE part(id TEXT PRIMARY KEY, data TEXT)");
  db.prepare("INSERT INTO message VALUES ('message', ?)").run("raw message 界");
  db.prepare("INSERT INTO part VALUES ('same', ?)").run("already archived");
  db.prepare("INSERT INTO part VALUES ('changed', ?)").run("new raw value");
  db.close();
  const projection = await openHistoryDatabase(converted);
  projection.exec("CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, data TEXT); CREATE TABLE openwork_payload(value TEXT)");
  projection.prepare("INSERT INTO session_message VALUES ('one', 'session', ?)").run('{"text":"one"}');
  projection.prepare("INSERT INTO session_message VALUES ('two', 'session', ?)").run('{"text":"two"}');
  projection.prepare("INSERT INTO openwork_payload VALUES (?)").run('界"\\\n');
  projection.close();
  const target = await openHistoryDatabase(request.targetDatabase);
  target.exec("CREATE TABLE openwork_v1_part(source_key TEXT, id TEXT, data TEXT); CREATE TABLE session_message(id TEXT PRIMARY KEY, data TEXT)");
  target.prepare("INSERT INTO openwork_v1_part VALUES ('key', 'same', 'already archived')").run();
  target.prepare("INSERT INTO openwork_v1_part VALUES ('key', 'changed', 'old raw value')").run();
  target.prepare("INSERT INTO session_message VALUES ('one', ?)").run('{"text":"one"}');
  target.close();
  await writeFile(request.source, "synthetic live source sentinel");
  const checkpoint = join(staging, "checkpoint.json");
  const save = (phase: string, extra: object = {}) => writeFile(checkpoint, JSON.stringify({ source: request.source, target: request.targetDatabase,
    phase, sourceKey: "key", snapshotStartedAt: 1, ...extra }));
  return { directory, request, original, converted, checkpoint, save,
    dispose: () => rm(directory, { recursive: true, force: true }) };
}

for (const phase of ["snapshot", "externalizing", "converting", "restoring", "copying", "completed"]) {
  test(`worker keeps the exact ${phase} estimate and source bytes`, async () => {
    const f = await fixture();
    try {
      await f.save(phase);
      const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
      const files = [f.request.source, f.original, f.converted, f.checkpoint, f.request.targetDatabase];
      const before = await Promise.all(files.map(digest));
      const bytes = await estimateHistoryCopyBytes(f.request);
      assert.equal(await estimateHistoryCopyOffMain(f.request), bytes);
      assert.deepEqual(await Promise.all(files.map(digest)), before);
      // Restoring includes JSON quoting/UTF-8 and two future payload copies.
      if (phase === "restoring") {
        const target = (await readFile(f.request.targetDatabase)).length;
        const payloadBytes = Buffer.byteLength(JSON.stringify('界"\\\n'));
        assert.equal(bytes, Buffer.byteLength("raw message 界new raw value") + Buffer.byteLength('{"text":"one"}{"text":"two"}') + payloadBytes * 2 + target);
      }
      await f.save(phase, { backupPath: "synthetic-existing-backup" });
      assert.equal(await estimateHistoryCopyOffMain(f.request), await estimateHistoryCopyBytes(f.request));
    } finally { await f.dispose(); }
  });
}

test("refusal preserves exact text, checkpoint, raw/projected data and ownership ordering", async () => {
  const f = await fixture();
  try {
    await f.save("restoring");
    const before = await readFile(f.checkpoint, "utf8");
    const entries = await readdir(f.directory);
    let checks = 0;
    await assert.rejects(preflightHistoryCopy({ ...f.request, freeBytes: async directory => {
      checks++; assert.equal(directory, f.request.storageDir); return 0;
    } }), { message: "Not enough free disk space to upgrade safely. Free up about 1.1 GB and try again. Nothing was changed." });
    assert.equal(checks, 1);
    assert.equal(await readFile(f.checkpoint, "utf8"), before);
    assert.deepEqual(await readdir(f.directory), entries);
    await preflightHistoryCopy({ ...f.request, freeBytes: async () => undefined });
    await preflightHistoryCopy({ ...f.request, freeBytes: async () => Number.MAX_SAFE_INTEGER });
  } finally { await f.dispose(); }
});

test("saved-profile, malformed-checkpoint and missing-fingerprint refusals survive worker transport", async () => {
  const f = await fixture();
  try {
    for (const [extra, error] of [
      [{ source: "another-profile" }, "The saved history copy belongs to another profile. Its files were preserved."],
      [{ sourceKey: undefined }, "The saved history source is missing its fingerprint."],
      [{ phase: "invalid" }, "The saved history copy is invalid. Its files were preserved."],
      [{ snapshotStartedAt: undefined }, "The saved copy has no snapshot time. Its files were preserved."],
    ]) {
      await f.save("restoring", extra);
      await assert.rejects(preflightHistoryCopy(f.request), { message: error });
    }
    await writeFile(f.checkpoint, "{broken");
    await assert.rejects(preflightHistoryCopy(f.request), { message: "The saved history copy could not be read. Its files were preserved." });
  } finally { await f.dispose(); }
});

test("worker SQL failures close safely without exposing paths or data", async () => {
  const f = await fixture();
  try {
    await f.save("restoring");
    await writeFile(f.converted, "private invalid database bytes");
    await assert.rejects(estimateHistoryCopyOffMain(f.request), { message: HISTORY_PREFLIGHT_FAILED });
  } finally { await f.dispose(); }
});

test("pre-aborted preflight does not create storage or call disk callback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preflight-abort-"));
  try {
    let calls = 0;
    const abort = new AbortController(); abort.abort(new Error("synthetic shutdown"));
    await assert.rejects(preflightHistoryCopy({ source: join(directory, "source"), storageDir: join(directory, "storage"),
      targetDatabase: join(directory, "target"), signal: abort.signal, freeBytes: async () => { calls++; return 0; } }), { message: "synthetic shutdown" });
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
