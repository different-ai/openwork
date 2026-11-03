import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { historyRevision, runEngineAutoUpgrade } from "../src/engine-auto-upgrade.js";
import { readHistoryRevision } from "../src/history-preparation-reader.js";
import { readMigrationSessions, snapshotV1Database } from "../src/opencode-v2-migration.js";
import { openHistoryDatabase } from "../src/opencode-v2-history-store.js";

async function fixture(run: (database: string, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "openwork-preparation-safety-"));
  const database = join(directory, "synthetic.db");
  const db = await openHistoryDatabase(database);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, parent_id TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, data BLOB);
      INSERT INTO session VALUES ('chat', 'Synthetic', '/synthetic', NULL, 1);
      INSERT INTO message VALUES ('message', 'unchanged');
      INSERT INTO part VALUES ('part', x'00ff0102');`);
    await run(database, directory);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}

test("isolated revision retains the exact byte framing of the reader and inventory remains ordered", async () => {
  await fixture(async database => {
    const bytes = await readFile(database);
    const wal = await readFile(`${database}-wal`);
    assert.equal(await historyRevision(database), await readHistoryRevision(database));
    assert.deepEqual(await readMigrationSessions(database), [{ id: "chat", title: "Synthetic", directory: "/synthetic", parentId: null }]);
    assert.deepEqual(await readFile(database), bytes);
    assert.deepEqual(await readFile(`${database}-wal`), wal);
  });
});

test("pre-aborted revision and inventory never open history or create a missing source", async () => {
  const abort = new AbortController();
  abort.abort(new Error("synthetic shutdown"));
  await assert.rejects(historyRevision("/synthetic/does-not-exist.db", abort.signal), /synthetic shutdown/);
  await assert.rejects(readMigrationSessions("/synthetic/does-not-exist.db", abort.signal), /synthetic shutdown/);
});

test("cancellation joins a live reader before returning and never reaches copy or switch", async () => {
  await fixture(async database => {
    const abort = new AbortController();
    let copied = false;
    let switched = false;
    const preparation = runEngineAutoUpgrade({ signal: abort.signal, idle: async () => true,
      revision: () => {
        const pending = historyRevision(database, abort.signal);
        // Worker has been created, but its result has not been delivered yet.
        abort.abort(new Error("synthetic shutdown"));
        return pending;
      }, copy: async () => { copied = true; }, switchEngine: async () => { switched = true; } });
    await assert.rejects(preparation, /synthetic shutdown/);
    assert.equal(copied, false);
    assert.equal(switched, false);
    assert.equal(await historyRevision(database), await readHistoryRevision(database), "another read can start immediately after cancellation");
  });
});

for (const phase of ["snapshot", "copy", "switch"] ) {
  test(`same-size WAL writes at ${phase} keep v1 selected rather than switching stale history`, async () => {
    await fixture(async (database, directory) => {
      const writer = await openHistoryDatabase(database);
      const snapshot = join(directory, "snapshot.db");
      let switched = false;
      let persistedRevision = "";
      try {
        const mutate = () => writer.exec("UPDATE message SET data = 'different'");
        await assert.rejects(runEngineAutoUpgrade({ signal: new AbortController().signal, idle: async () => true,
          revision: () => historyRevision(database),
          copy: async () => {
            persistedRevision = await historyRevision(database);
            if (phase === "snapshot") mutate();
            await snapshotV1Database(database, snapshot);
            if (phase === "copy") mutate();
            if (persistedRevision !== await historyRevision(database)) throw new Error("v1 changed since snapshot");
          },
          switchEngine: async () => {
            // Same check as the production final engine-switch fence, after v2 starts.
            if (phase === "switch") mutate();
            if (persistedRevision !== await historyRevision(database)) throw new Error("v1 changed while v2 started");
            switched = true;
          } }), /v1 changed/);
        assert.equal(switched, false);
        assert.notEqual(await historyRevision(database), persistedRevision);
      } finally { writer.close(); }
    });
  });
}

test("unreadable history fails closed, without exposing a source path in the worker error", { skip: typeof process.versions.bun === "string" ? "Cross-thread errors belong to the Node/Electron host" : false }, async () => {
  await assert.rejects(historyRevision("/synthetic/private-name/missing.db"), error =>
    error instanceof Error && error.message.includes("Keeping v1") && !error.message.includes("private-name"));
});
