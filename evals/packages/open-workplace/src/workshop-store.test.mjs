import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSnapshotStore } from "./workshop-store.mjs";

const root = "/private/var/folders/8j/hhcc8zs100d3fd654fjkk9580000gn/T/opencode";
function fileFor(t) {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "workshop-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "state.sqlite");
}

test("generic synchronous snapshots preserve v8 data, binary bytes and independent keys across reopen", (t) => {
  const file = fileFor(t);
  let store = createSnapshotStore({ file });
  const value = { bytes: Buffer.from([0, 255, 128, 42]), date: new Date(1000), map: new Map([["count", 4]]), nested: [undefined, 2n] };
  assert.equal(store.read("absent"), undefined);
  store.write("business", value);
  store.write("hashed-auth", { digest: "fictional-test-digest" });
  store.close();
  store = createSnapshotStore({ file });
  assert.deepEqual(store.read("business"), value);
  assert.equal(Buffer.isBuffer(store.read("business").bytes), true);
  store.delete("business");
  assert.equal(store.read("business"), undefined);
  assert.deepEqual(store.read("hashed-auth"), { digest: "fictional-test-digest" });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(`${file}-wal`).mode & 0o777, 0o600);
  assert.equal(statSync(`${file}-shm`).mode & 0o777, 0o600);
  assert.equal(statSync(join(file, "..")).mode & 0o777, 0o700);
  store.close();
});

test("a failed SQLite statement leaves the previous atomic snapshot intact", (t) => {
  const file = fileFor(t); const store = createSnapshotStore({ file });
  store.write("state", { revision: 1 });
  const db = new DatabaseSync(file);
  db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'test disk failure'); END;");
  assert.throws(() => store.write("state", { revision: 2 }), /test disk failure/);
  assert.deepEqual(store.read("state"), { revision: 1 });
  db.close(); store.close();
});

test("corrupt, empty, wrong-version and malformed serialized data fail closed", (t) => {
  const file = fileFor(t);
  for (const content of [Buffer.alloc(0), Buffer.from("not a sqlite database")]) {
    writeFileSync(file, content);
    assert.throws(() => createSnapshotStore({ file }));
    assert.deepEqual(readFileSync(file), content);
    rmSync(file);
  }
  const store = createSnapshotStore({ file }); store.close();
  let db = new DatabaseSync(file);
  db.exec("UPDATE metadata SET value = '999' WHERE key = 'version'"); db.close();
  assert.throws(() => createSnapshotStore({ file }), /format\/version/);
  db = new DatabaseSync(file);
  db.exec("UPDATE metadata SET value = '1' WHERE key = 'version'; INSERT INTO snapshots VALUES ('bad', X'000102')"); db.close();
  const reopened = createSnapshotStore({ file });
  assert.throws(() => reopened.read("bad")); reopened.close();
});

test("relative paths, symlinks and unreadable file kinds are rejected", (t) => {
  const file = fileFor(t);
  assert.throws(() => createSnapshotStore({ file: "relative.sqlite" }), /absolute/);
  mkdirSync(file);
  assert.throws(() => createSnapshotStore({ file }));
  rmSync(file, { recursive: true });
  const target = `${file}.target`; writeFileSync(target, "untouched"); symlinkSync(target, file);
  assert.throws(() => createSnapshotStore({ file }), /regular file/);
  assert.equal(readFileSync(target, "utf8"), "untouched");
  rmSync(file); writeFileSync(file, "unreadable"); chmodSync(file, 0o000);
  assert.throws(() => createSnapshotStore({ file }), /readable and writable/);
  chmodSync(file, 0o600);
  assert.equal(readFileSync(file, "utf8"), "unreadable");
});
