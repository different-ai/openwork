import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEngineV2Preview, readEngineV2PreviewState, writeEngineV2PreviewState } from "../src/engine-v2-preview.js";
import { historyRevision } from "../src/engine-auto-upgrade.js";
import { backupV2Database, snapshotV1Database } from "../src/opencode-v2-migration.js";
import { openHistoryDatabase, stringField } from "../src/opencode-v2-history-store.js";
import type { ServerConfig } from "../src/types.js";

async function profile(run: (directory: string, config: ServerConfig) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-upgrade-safety-"));
  const overrides = {
    HOME: directory, USERPROFILE: directory, XDG_DATA_HOME: join(directory, "data"), XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"), OPENWORK_RUNTIME_DB: join(directory, "runtime.db"), OPENCODE_DB: join(directory, "v1.db"),
    OPENWORK_OPENCODE2_BIN: join(directory, "unavailable-opencode2"), OPENWORK_ENGINE_V2_PREVIEW: "",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
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

test("automatic routing is not persisted or published if policy expires during journal preparation", async () => {
  await profile(async (directory, config) => {
    await writeEngineV2PreviewState(config, { enabled: true, chatRouting: false });
    const before = await readFile(join(directory, "engine-v2-preview.json"));
    let eligible = true;
    let checks = 0;
    let published = false;
    const expired = new Error("Policy epoch expired");
    const selection = writeEngineV2PreviewState(config, { enabled: true, chatRouting: true }, {
      validate: () => { checks++; if (!eligible) throw expired; },
      apply: () => { published = true; },
    });
    assert.equal(checks, 1, "witness: preparation has started but the atomic rename has not");
    eligible = false;
    await assert.rejects(selection, error => error === expired);
    assert.equal(checks, 2, "eligibility is checked again after asynchronous journal preparation");
    assert.equal(published, false);
    assert.deepEqual(await readFile(join(directory, "engine-v2-preview.json")), before);
    assert.equal((await readdir(directory)).includes("engine-v2-preview.json.tmp"), false);
  });
});

test("automatic durable commit and routing publication cannot be split by a later policy callback", async () => {
  await profile(async (_directory, config) => {
    let checks = 0;
    let published = false;
    let callbackSawPublished = false;
    await writeEngineV2PreviewState(config, { enabled: true, chatRouting: true }, {
      validate: () => {
        if (++checks === 2) queueMicrotask(() => { callbackSawPublished = published; });
      },
      apply: () => {
        assert.equal(readEngineV2PreviewState(config).chatRouting, true, "publication follows the successful atomic rename");
        published = true;
      },
    });
    assert.equal(checks, 2);
    assert.equal(published, true);
    assert.equal(callbackSawPublished, true, "a later policy callback observes an already-selected engine, not a pending automatic cutover");
  });
});

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

test("rollout off preserves v2 routing as well as v1, v2 and retained backup bytes", async () => {
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
    const engine = createEngineV2Preview({ config });
    try {
      engine.setForcePolicy({ upgrade: false });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(engine.status().chatRouting, true);
      assert.equal(engine.status().engineOrigin, "forced");
      assert.equal(engine.status().engineForced, true);
    } finally { await engine.stop(); }
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    assert.equal(readEngineV2PreviewState(config).engineOrigin, "forced");
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

test("paused-copy recovery retains its backup receipt across process restarts", async () => {
  await profile(async (directory, config) => {
    const backupPath = join(directory, "opencode-v2", "backups", "baseline.db");
    await writeFile(join(directory, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
      automaticHistoryCopy: true, automaticHistoryRevision: "stale-source-revision",
      historyCopyResult: { state: "error", imported: 1, skipped: 0, total: 1, backupPath,
        error: "OpenCode v1 changed since the saved history snapshot" } }));
    assert.equal(readEngineV2PreviewState(config).historyCopyResult?.backupPath, backupPath,
      "the receipt remains inspectable for explicit recovery, never an automatic target rollback");
  });
});
