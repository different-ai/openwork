import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copyHistoryBatches, numberField, openHistoryDatabase, stringField } from "../src/opencode-v2-history-store.js";
import { migrateOpencodeV1History, type EngineV2MigrationStatus } from "../src/opencode-v2-migration.js";

for (const diverged of [false, true]) for (const initialSequence of [50, 1000]) {
  test(`an interrupted ${diverged ? "diverged" : "refreshed"} reconciliation keeps its owner and safe sequence (previous=${initialSequence})`, async () => {
    const db = await openHistoryDatabase(":memory:");
    try {
      db.exec(`ATTACH DATABASE ':memory:' AS original; ATTACH DATABASE ':memory:' AS converted;
        CREATE TABLE project (id TEXT PRIMARY KEY);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER, UNIQUE(session_id, seq));
        CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
        CREATE TABLE converted.project (id TEXT PRIMARY KEY);
        CREATE TABLE converted.session_v2 (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE converted.session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER, UNIQUE(session_id, seq));
        CREATE TABLE converted.event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
        CREATE TABLE original.session (id TEXT PRIMARY KEY);
        CREATE TABLE original.message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE original.part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        INSERT INTO original.session VALUES ('copy');
        INSERT INTO session_v2 VALUES ('copy', 'Existing metadata');
        INSERT INTO converted.session_v2 VALUES ('copy', 'Converted metadata');
        INSERT INTO converted.event_sequence VALUES ('copy', 150, NULL)`);
      for (let n = 0; n < 150; n++) {
        const id = `message-${String(n).padStart(3, "0")}`;
        db.prepare("INSERT INTO converted.session_message VALUES (?, 'copy', ?, 'user', ?, ?, ?)").run(id, n, JSON.stringify({ text: `message ${n}` }), n * 10, n * 10);
        db.prepare("INSERT INTO original.message VALUES (?, 'copy', ?, ?, ?)").run(id, n * 10, n * 10, JSON.stringify({ raw: n }));
      }
      db.exec("INSERT INTO session_message SELECT id, session_id, seq + 1, type, data, time_created, time_updated FROM converted.session_message WHERE seq < 2");
      if (diverged) db.exec("INSERT INTO session_message VALUES ('native-turn', 'copy', 40, 'assistant', '{\"native\":true}', 755, 755)");
      db.prepare("INSERT INTO event_sequence VALUES ('copy', ?, 'existing-owner')").run(initialSequence);
      const controller = new AbortController();
      const request = { database: db, sourceKey: "source", progress: () => {} };
      await assert.rejects(copyHistoryBatches({ ...request, signal: controller.signal,
        batch: async () => { controller.abort(new Error("Intentional committed-batch interruption")); } }), /Intentional committed-batch interruption/);
      assert.equal(numberField(db.prepare("SELECT completed FROM openwork_history_copy").get(), "completed"), 0);
      assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 0);
      assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM session_message").get(), "n"), diverged ? 151 : 150);
      const sequence = numberField(db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id = 'copy'").get(), "seq");
      assert.ok(sequence >= numberField(db.prepare("SELECT max(seq) AS seq FROM session_message").get(), "seq"));
      assert.equal(sequence, Math.max(initialSequence, 150), "advance atomically, but never rewind");
      assert.equal(stringField(db.prepare("SELECT owner_id FROM event_sequence WHERE aggregate_id = 'copy'").get(), "owner_id"), "existing-owner");
      await copyHistoryBatches(request);
      assert.equal(numberField(db.prepare("SELECT completed FROM openwork_history_copy").get(), "completed"), 1);
      assert.equal(numberField(db.prepare("SELECT seq FROM event_sequence WHERE aggregate_id = 'copy'").get(), "seq"), sequence);
      assert.equal(stringField(db.prepare("SELECT owner_id FROM event_sequence WHERE aggregate_id = 'copy'").get(), "owner_id"), "existing-owner");
    } finally { db.close(); }
  });
}

test("a copying-stage resume rechecks remaining disk space before changing target data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-resume-preflight-"));
  try {
    const source = join(directory, "v1.db");
    const storageDir = join(directory, "v2");
    const stage = join(storageDir, "history-copy");
    const converted = join(stage, "converted");
    const target = join(directory, "target.db");
    await mkdir(converted, { recursive: true });
    let db = await openHistoryDatabase(source);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)`);
    db.close();
    await copyFile(source, join(stage, "source.db"));
    db = await openHistoryDatabase(target);
    db.exec("CREATE TABLE session_message (id TEXT PRIMARY KEY, data TEXT); INSERT INTO session_message VALUES ('native-row', '{\"native\":true}')");
    db.close();
    const before = createHash("sha256").update(await readFile(target)).digest("hex");
    const volume = await statfs(directory);
    const available = Number(volume.bavail) * Number(volume.bsize);
    const rows = Math.ceil((available + 1024 ** 3) / 500_000_000) + 2;
    db = await openHistoryDatabase(join(converted, "opencode.db"));
    // SQLite keeps zeroblobs virtual for length(CAST(... AS BLOB)). This reports
    // more remaining work than the actual volume has, without filling the disk
    // or mocking production disk availability.
    db.exec(`CREATE VIEW session_message AS WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x+1 < ${rows})
      SELECT 'pending-' || x AS id, 'copy' AS session_id, zeroblob(500000000) AS data FROM n`);
    db.close();
    const sourceKey = createHash("sha256").update(await readFile(join(stage, "source.db"))).digest("hex");
    await writeFile(join(stage, "checkpoint.json"), JSON.stringify({ source, target, phase: "copying", sourceKey, snapshotStartedAt: 1 }));
    let status: EngineV2MigrationStatus | undefined;
    await migrateOpencodeV1History({ source, storageDir, targetDatabase: target, bin: "/unused-copying-stage", progress: next => { status = next; } });
    assert.equal(status?.state, "error");
    assert.match(status?.error ?? "", /Not enough free disk space/);
    assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
