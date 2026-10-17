import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState } from "../src/engine-v2-preview.js";
import { historyRevision } from "../src/engine-auto-upgrade.js";
import { backupV2Database, snapshotV1Database } from "../src/opencode-v2-migration.js";
import { openHistoryDatabase, stringField } from "../src/opencode-v2-history-store.js";
import type { ServerConfig } from "../src/types.js";

async function profile(run: (directory: string, config: ServerConfig) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-upgrade-safety-"));
  const previous = { OPENWORK_RUNTIME_DB: process.env.OPENWORK_RUNTIME_DB, OPENCODE_DB: process.env.OPENCODE_DB,
    OPENWORK_ENGINE_V2_PREVIEW: process.env.OPENWORK_ENGINE_V2_PREVIEW };
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.db");
  process.env.OPENCODE_DB = join(directory, "v1.db");
  delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
    engineForcePolicy: true, engineAutoUpgrade: false,
  };
  try { await run(directory, config); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("v2 backups retain the newest two WAL-complete snapshots without writing the source", async () => {
  await profile(async (directory) => {
    const database = join(directory, "v2.db");
    const db = await openHistoryDatabase(database);
    const backups = join(directory, "backups");
    const paths: string[] = [];
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE chat (id TEXT PRIMARY KEY, data TEXT); INSERT INTO chat VALUES ('independent-v2', 'initial')");
      for (let index = 0; index < 3; index++) {
        db.prepare("UPDATE chat SET data = ?").run(`version-${index}`);
        const beforeMain = await readFile(database);
        const beforeWal = await readFile(`${database}-wal`);
        const path = await backupV2Database({ database, directory: backups, now: new Date(Date.UTC(2026, 0, index + 1)) });
        assert.ok(path);
        paths.push(path);
        assert.deepEqual(await readFile(database), beforeMain);
        assert.deepEqual(await readFile(`${database}-wal`), beforeWal);
        const snapshot = await openHistoryDatabase(path);
        try { assert.equal(stringField(snapshot.prepare("SELECT data FROM chat").get(), "data"), `version-${index}`); }
        finally { snapshot.close(); }
      }
      assert.equal((await readdir(backups)).filter(name => name.endsWith(".db")).length, 2);
      await assert.rejects(readFile(paths[0] ?? ""), { code: "ENOENT" });
      const baseline = paths[1];
      assert.ok(baseline);
      const restored = join(directory, "restored.db");
      await snapshotV1Database(baseline, restored);
      const restoredDb = await openHistoryDatabase(restored);
      try { assert.equal(stringField(restoredDb.prepare("SELECT data FROM chat").get(), "data"), "version-1"); }
      finally { restoredDb.close(); }
    } finally { db.close(); }
  });
});

test("forced revert changes routing without changing v1, v2, or retained backups", async () => {
  await profile(async (directory, config) => {
    const target = join(directory, "opencode-v2", "state", "opencode.db");
    const backup = join(directory, "opencode-v2", "backups", "baseline.db");
    await mkdir(join(directory, "opencode-v2", "state"), { recursive: true });
    await mkdir(join(directory, "opencode-v2", "backups"), { recursive: true });
    const files = [join(directory, "v1.db"), target, backup];
    for (const file of files) {
      const db = await openHistoryDatabase(file);
      try { db.exec("CREATE TABLE original (data TEXT); INSERT INTO original VALUES ('preserve original bytes')"); }
      finally { db.close(); }
    }
    const before = await Promise.all(files.map(file => readFile(file)));
    await writeFile(join(directory, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true,
      engineOrigin: "forced", engineForced: true }));
    const engine = createEngineV2Preview({ config, autoRevertIdle: async () => true });
    try {
      for (let check = 0; check < 100 && engine.status().chatRouting; check++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(engine.status().chatRouting, false);
      assert.equal(engine.status().engineOrigin, "reverted");
      assert.equal(engine.status().engineForced, false);
    } finally { await engine.stop(); }
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    assert.equal(readEngineV2PreviewState(config).engineOrigin, "reverted");
  });
});

test("chunked history revision detects payload edits past slice boundaries and preserves source bytes", async () => {
  await profile(async (directory) => {
    const database = join(directory, "v1.db");
    const db = await openHistoryDatabase(database);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, data TEXT);
        INSERT INTO session VALUES ('chat', 'Original');
        INSERT INTO message VALUES ('message', NULL);
        INSERT INTO part SELECT 'part', replace(hex(zeroblob(2097152)), '00', 'x') || '界🦆';`);
      const beforeMain = await readFile(database);
      const beforeWal = await readFile(`${database}-wal`);
      const initial = await historyRevision(database);
      assert.equal(await historyRevision(database), initial);
      assert.deepEqual(await readFile(database), beforeMain);
      assert.deepEqual(await readFile(`${database}-wal`), beforeWal);
      // Same-byte-length Unicode edit beyond several 512 KiB slice boundaries.
      db.exec("UPDATE part SET data = substr(data, 1, 2097152) || '語🦆'");
      const changed = await historyRevision(database);
      assert.notEqual(changed, initial);
      db.exec("UPDATE message SET data = ''");
      assert.notEqual(await historyRevision(database), changed, "NULL and empty payloads have different framing");
      db.exec("UPDATE message SET data = NULL; UPDATE part SET data = substr(data, 1, 2097152) || '界🦆'");
      assert.equal(await historyRevision(database), initial);
    } finally { db.close(); }
  });
});

test("stale-copy recovery retains the baseline backup reference across process restarts", async () => {
  await profile(async (directory, config) => {
    const backupPath = join(directory, "opencode-v2", "backups", "baseline.db");
    await writeFile(join(directory, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
      automaticHistoryCopy: true, automaticHistoryRevision: "stale-source-revision",
      historyCopyResult: { state: "error", imported: 1, skipped: 0, total: 1, backupPath,
        error: "OpenCode v1 changed since the saved history snapshot" } }));
    assert.equal(readEngineV2PreviewState(config).historyCopyResult?.backupPath, backupPath,
      "the next boot must restore this pre-copy target before copying a newer v1 revision");
  });
});
