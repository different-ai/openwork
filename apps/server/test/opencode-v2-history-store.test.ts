import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { attachHistory, externalizeHistory, numberField, openHistoryDatabase, stringField } from "../src/opencode-v2-history-store.js";

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
      assert.equal(stringField(db.prepare("SELECT value FROM openwork_payload WHERE token = ?").get(uriToken.split(",")[1] ?? ""), "value"),
        Buffer.from("Original attachment 界🦆 /%".repeat(1000)).toString("base64"));
      const count = numberField(db.prepare("SELECT count(*) AS n FROM openwork_payload").get(), "n");
      await externalizeHistory(db);
      assert.equal(numberField(db.prepare("SELECT count(*) AS n FROM openwork_payload").get(), "n"), count);
      assert.equal(stringField(db.prepare("SELECT json_extract(data, '$.url') AS value FROM original.part").get(), "value"), url);
    } finally { db.close(); }

    // The final copy opens both snapshots through the same attachment helper.
    const target = await openHistoryDatabase(join(directory, "target.db"));
    try {
      attachHistory(target, source, "original");
      attachHistory(target, converted, "converted");
      target.exec("CREATE TABLE copied AS SELECT * FROM converted.message");
      assert.equal(numberField(target.prepare("SELECT count(*) AS n FROM copied").get(), "n"), 1);
      assert.throws(() => target.exec("DELETE FROM converted.message"), /readonly/i);
    } finally { target.close(); }
    assert.deepEqual(await readFile(source), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
