import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachHistory, copyHistoryBatches, externalizeHistory, numberField, openHistoryDatabase, restoreHistoryPayloads, stringField, type HistoryDatabase } from "../src/opencode-v2-history-store.js";

// No native engine binary is required: exercise the real SQLite connection and
// staging path on Bun (including Linux, whose default URI support differs).
test("history attachments externalize copied payloads while enforcing read-only sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-history-store-"));
  const source = join(directory, "source '界 %?#.db");
  const converted = join(directory, "converted '界 %?#.db");
  const text = "Original text 界🦆\"\\\n".repeat(1000);
  const url = "data:text/plain," + encodeURIComponent("Original attachment 界🦆 /%".repeat(1000));
  try {
    const original = await openHistoryDatabase(source);
    try {
      original.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
        INSERT INTO session VALUES ('session');`);
      original.prepare("INSERT INTO message VALUES ('message', 'session', ?)").run(JSON.stringify({ text }));
      original.prepare("INSERT INTO part VALUES ('part', 'session', ?)").run(JSON.stringify({ type: "file", url }));
    } finally { original.close(); }
    const before = await readFile(source);
    await copyFile(source, converted);
    const db = await openHistoryDatabase(converted);
    try {
      attachHistory(db, source, "original");
      assert.equal(stringField(db.prepare("SELECT json_extract(data, '$.text') AS value FROM original.message").get(), "value"), text);
      assert.throws(() => db.exec("UPDATE original.message SET data = '{}'"), /readonly/i);
      assert.throws(() => db.exec("CREATE TABLE original.forbidden (id TEXT)"), /readonly/i);
      await externalizeHistory(db);
      const token = stringField(db.prepare("SELECT json_extract(data, '$.text') AS value FROM message").get(), "value");
      assert.match(token, /^OWPAYLOAD[0-9a-f]+END$/);
      assert.equal(stringField(db.prepare("SELECT value FROM openwork_payload WHERE token = ?").get(token), "value"), text);
      const uriToken = stringField(db.prepare("SELECT json_extract(data, '$.url') AS value FROM part").get(), "value");
      assert.match(uriToken, /^data:text\/plain;base64,/);
      assert.equal(stringField(db.prepare("SELECT value FROM openwork_payload WHERE token = ?").get(uriToken), "value"), url);
      assert.equal(stringField(db.prepare("SELECT value FROM openwork_payload WHERE token = ?").get(uriToken.split(",")[1] ?? ""), "value"), Buffer.from("Original attachment 界🦆 /%".repeat(1000)).toString("base64"));
      const count = numberField(db.prepare("SELECT count(*) AS n FROM openwork_payload").get(), "n");
      await externalizeHistory(db);
      assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_payload").get(), "n"), count);
      assert.equal(stringField(db.prepare("SELECT json_extract(data, '$.url') AS value FROM original.part").get(), "value"), url);
    } finally { db.close(); }
    const target = await openHistoryDatabase(join(directory, "target.db"));
    try {
      attachHistory(target, source, "original"); attachHistory(target, converted, "converted");
      target.exec("CREATE TABLE copied AS SELECT * FROM converted.message");
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM copied").get(), "n"), 1);
      assert.throws(() => target.exec("DELETE FROM converted.message"), /readonly/i);
    } finally { target.close(); }
    assert.deepEqual(await readFile(source), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Frozen reference algorithm: equivalence includes escaping and longest-first
// replacement of full tool URIs before their embedded base64 payload token.
function oldRestore(db: HistoryDatabase) {
  for (const row of db.prepare("SELECT id FROM session_message ORDER BY id").all()) {
    const id = stringField(row, "id");
    for (const item of db.prepare(`SELECT token FROM openwork_payload WHERE instr((SELECT data FROM session_message WHERE id = ?), token) > 0 ORDER BY length(token) DESC`).all(id)) {
      const token = stringField(item, "token");
      db.prepare(`UPDATE session_message SET data = replace(data, ?, (SELECT substr(json_quote(value), 2, length(json_quote(value)) - 2) FROM openwork_payload WHERE token = ?)) WHERE id = ?`).run(token, token, id);
    }
    assert.ok(!db.prepare(`SELECT 1 FROM session_message m WHERE m.id = ? AND EXISTS (SELECT 1 FROM openwork_payload p WHERE instr(m.data, p.token) > 0)`).get(id));
  }
}

for (const unmapped of [false, true]) test(`restore is byte-identical to the old algorithm (unmapped=${unmapped}) and resumes`, async () => {
  const root = await mkdtemp(join(tmpdir(), "history-restore-equivalence-"));
  let db = await openHistoryDatabase(join(root, "new.db"));
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('s');
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      ATTACH DATABASE ':memory:' AS original;
      CREATE TABLE original.part (id TEXT PRIMARY KEY, data TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)`);
    const values = [
      { text: '界🦆"\\\n'.repeat(1500) },
      { url: "data:image/png;base64," + Buffer.from("image".repeat(2000)).toString("base64") },
      { url: "data:text/plain," + encodeURIComponent("界🦆 /%".repeat(2000)) },
      { url: "data:text/plain," + encodeURIComponent("tool file /%".repeat(1000)) },
    ];
    for (const [n, value] of values.entries()) {
      db.prepare("INSERT INTO part VALUES (?, 's', ?)").run(String(n), JSON.stringify(value));
      db.prepare("INSERT INTO original.part VALUES (?, ?)").run(String(n), JSON.stringify(value));
    }
    await externalizeHistory(db);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_payload_session").get(), "n"), 7);
    db.exec(`INSERT INTO session_message SELECT id, session_id, CASE WHEN id IN ('1','2')
      THEN json_object('data', substr(json_extract(data, '$.url'), instr(json_extract(data, '$.url'), ',') + 1)) ELSE data END FROM part;
      INSERT INTO session_message VALUES ('no-marker', 's', '{"text":"unchanged"}');
      DROP TABLE openwork_payload_session`);
    if (unmapped) db.exec("DELETE FROM part WHERE id = '3'"); // Full URI and encoded suffix must both take the global path.
    db.close();
    await copyFile(join(root, "new.db"), join(root, "old.db"));
    const old = await openHistoryDatabase(join(root, "old.db"));
    db = await openHistoryDatabase(join(root, "new.db"));
    try {
      oldRestore(old);
      let globalScans = 0;
      const traced: HistoryDatabase = {
        exec: sql => db.exec(sql), close: () => db.close(),
        prepare: sql => {
          const statement = db.prepare(sql);
          return {
            all: (...params) => {
              if (sql.startsWith("SELECT token FROM openwork_payload WHERE")) globalScans++;
              return statement.all(...params);
            },
            get: (...params) => statement.get(...params), run: (...params) => statement.run(...params),
          };
        },
      };
      const controller = new AbortController();
      await assert.rejects(restoreHistoryPayloads(traced, controller.signal, done => { if (done === 0) controller.abort(); }));
      await restoreHistoryPayloads(traced);
      assert.equal(globalScans > 0, unmapped, "mapped messages must never scan global payloads");
      assert.deepEqual(db.prepare("SELECT id, data FROM session_message ORDER BY id").all(), old.prepare("SELECT id, data FROM session_message ORDER BY id").all());
      assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_restored").get(), "n"), 5);
      await restoreHistoryPayloads(db);
      assert.deepEqual(db.prepare("SELECT id, data FROM session_message ORDER BY id").all(), old.prepare("SELECT id, data FROM session_message ORDER BY id").all());
    } finally { old.close(); }
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("a token introduced by a payload value still fails the old exact unresolved check", async () => {
  const db = await openHistoryDatabase(":memory:");
  const a = `OWPAYLOAD${"a".repeat(48)}END`;
  const b = `OWPAYLOAD${"b".repeat(48)}END`;
  try {
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      CREATE TABLE openwork_payload (token TEXT PRIMARY KEY, value TEXT)`);
    db.prepare("INSERT INTO openwork_payload VALUES (?, ?), (?, 'must not recursively substitute')").run(a, b, b);
    db.prepare("INSERT INTO message VALUES ('a', 's', json_object('text', ?)), ('b', 's', json_object('text', ?))").run(a, b);
    db.exec("INSERT INTO session_message SELECT * FROM message WHERE id = 'a'");
    await assert.rejects(restoreHistoryPayloads(db), /Unresolved history payload/);
    assert.equal(stringField(db.prepare("SELECT json_extract(data, '$.text') AS value FROM session_message").get(), "value"), a);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_restored").get(), "n"), 0);
  } finally { db.close(); }
});

async function copyFixture(): Promise<HistoryDatabase> {
  const db = await openHistoryDatabase(":memory:");
  db.exec(`ATTACH DATABASE ':memory:' AS original; ATTACH DATABASE ':memory:' AS converted;
    CREATE TABLE project (id TEXT PRIMARY KEY);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, time_archived INTEGER);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER, UNIQUE(session_id, seq));
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
    CREATE TABLE converted.project (id TEXT PRIMARY KEY);
    CREATE TABLE converted.session_v2 (id TEXT PRIMARY KEY, title TEXT, time_archived INTEGER);
    CREATE TABLE converted.session_message (id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, data TEXT, time_created INTEGER, time_updated INTEGER, UNIQUE(session_id, seq));
    CREATE TABLE converted.event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER, owner_id TEXT);
    CREATE TABLE original.session (id TEXT PRIMARY KEY);
    CREATE TABLE original.message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE original.part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    INSERT INTO original.session VALUES ('s');
    INSERT INTO session_v2 VALUES ('s', 'Keep target title', NULL);
    INSERT INTO converted.session_v2 VALUES ('s', 'Converted', NULL);
    INSERT INTO converted.session_message VALUES ('a', 's', 0, 'user', '{"text":"first"}', 10, 10), ('b', 's', 1, 'assistant', '{"text":"middle"}', 20, 20), ('c', 's', 2, 'user', '{"text":"last"}', 30, 30);
    INSERT INTO session_message SELECT id, session_id, seq + 1, type, data, time_created, time_updated FROM converted.session_message WHERE id != 'b';
    INSERT INTO original.message VALUES ('a', 's', 10, 10, '{"raw":"original"}');
    INSERT INTO original.part VALUES ('p', 'a', 's', 10, 10, '{"raw":"part"}');
    INSERT INTO event_sequence VALUES ('s', 100, 'existing-owner')`);
  assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM original.session").get(), "n"), 1);
  assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM converted.session_v2").get(), "n"), 1);
  assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM session_message").get(), "n"), 2);
  return db;
}

for (const diverged of [false, true]) test(`stale projection is losslessly reconciled and resumes (diverged=${diverged})`, async () => {
  const db = await copyFixture();
  try {
    db.prepare("INSERT INTO session_message VALUES ('extra', 's', 50, ?, '{\"native\":true}', 25, 25)").run(diverged ? "user" : "system");
    const before = db.prepare("SELECT * FROM session_message ORDER BY id").all();
    const request = { database: db, sourceKey: "source", progress: () => {} };
    await assert.rejects(copyHistoryBatches({ ...request, batch: async () => { throw new Error("kill boundary"); } }), /kill boundary/);
    assert.equal(numberField(db.prepare("SELECT cursor FROM openwork_history_copy").get(), "cursor"), 2);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 0);
    await copyHistoryBatches(request);
    assert.equal(numberField(db.prepare("SELECT completed FROM openwork_history_copy").get(), "completed"), 1);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 0);
    assert.deepEqual(db.prepare("SELECT id, session_id, seq, type, data, time_created, time_updated FROM openwork_v2_replaced_message ORDER BY id").all(), before);
    assert.deepEqual(db.prepare("SELECT id FROM session_message ORDER BY seq").all().map(row => stringField(row, "id")), diverged ? ["a", "b", "extra", "c"] : ["a", "b", "c"]);
    assert.equal(numberField(db.prepare("SELECT seq FROM event_sequence").get(), "seq"), 100);
    assert.equal(stringField(db.prepare("SELECT owner_id FROM event_sequence").get(), "owner_id"), "existing-owner");
    assert.equal(stringField(db.prepare("SELECT title FROM session_v2").get(), "title"), "Keep target title");
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_v1_part").get(), "n"), 1);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM converted.session_message s JOIN session_message t ON t.id = s.id AND t.data = s.data").get(), "n"), 3);
    assert.equal((await copyHistoryBatches(request)).skipped, 1);
  } finally { db.close(); }
});

test("new-session ownership survives an interrupted copy and resume", async () => {
  const db = await copyFixture();
  try {
    db.exec("DELETE FROM session_message; DELETE FROM session_v2");
    const request = { database: db, sourceKey: "source", progress: () => {} };
    await assert.rejects(copyHistoryBatches({ ...request, batch: async () => { throw new Error("kill boundary"); } }), /kill boundary/);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 1);
    await copyHistoryBatches(request);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 1);
    assert.equal(numberField(db.prepare("SELECT completed FROM openwork_history_copy").get(), "completed"), 1);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM session_message").get(), "n"), 3);
  } finally { db.close(); }
});

test("legacy checkpoints gain created-session ownership once, preserving existing rows as created", async () => {
  const db = await copyFixture();
  try {
    db.exec(`CREATE TABLE openwork_history_copy (source_key TEXT, session_id TEXT, cursor INTEGER NOT NULL DEFAULT -1,
      completed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source_key, session_id));
      INSERT INTO openwork_history_copy VALUES ('legacy', 'legacy-created', 63, 0)`);
    const request = { database: db, sourceKey: "source", progress: () => {} };
    await copyHistoryBatches(request);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy WHERE source_key = 'legacy'").get(), "created_session"), 1);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy WHERE source_key = 'source'").get(), "created_session"), 0);
    await copyHistoryBatches(request);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM pragma_table_info('openwork_history_copy') WHERE name = 'created_session'").get(), "n"), 1);
    assert.equal(numberField(db.prepare("SELECT cursor FROM openwork_history_copy WHERE source_key = 'legacy'").get(), "cursor"), 63);
  } finally { db.close(); }
});

test("equal id sets preserve v2 edits but still archive all raw v1 rows", async () => {
  const db = await copyFixture();
  try {
    db.exec("INSERT INTO session_message SELECT id, session_id, 2, type, data, time_created, time_updated FROM converted.session_message WHERE id = 'b'; UPDATE session_message SET data = '{\"edited\":true}' WHERE id = 'a'");
    const before = db.prepare("SELECT * FROM session_message ORDER BY id").all();
    const request = { database: db, sourceKey: "source", progress: () => {} };
    await assert.rejects(copyHistoryBatches({ ...request, batch: async () => { throw new Error("kill boundary"); } }), /kill boundary/);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 0);
    const result = await copyHistoryBatches(request);
    assert.equal(numberField(db.prepare("SELECT created_session FROM openwork_history_copy").get(), "created_session"), 0);
    assert.equal(result.imported, 1);
    assert.deepEqual(db.prepare("SELECT * FROM session_message ORDER BY id").all(), before);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_v1_message").get(), "n"), 1);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_v1_part").get(), "n"), 1);
    assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_v2_replaced_message").get(), "n"), 0);
  } finally { db.close(); }
});
