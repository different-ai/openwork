import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { opencodeV1DatabasePath, resolveOpencodeHistoryDatabase, v1ChatDirectory } from "../src/opencode-history.js";
import { importNodeSqlite } from "../src/runtime-db.js";

async function openDatabase(path: string) {
  return typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(path, { create: true })
    : new (await importNodeSqlite()).DatabaseSync(path);
}

async function fixture(run: (root: string, legacy: string, source: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-history-selection-"));
  const legacy = join(root, "legacy-v2");
  await mkdir(legacy);
  try { await run(root, legacy, join(root, "original.db")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function database(path: string, sql: string) {
  const db = await openDatabase(path);
  try { db.exec(sql); }
  finally { db.close(); }
}

async function preserved(path: string, run: () => Promise<unknown>) {
  const before = await readFile(path);
  await run();
  assert.deepEqual(await readFile(path), before, `${path} must not be rewritten`);
}

const initializedSchema = `CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE project (id TEXT PRIMARY KEY);
  INSERT INTO project VALUES ('global');`;
const v1Schema = "CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, parent_id TEXT);";

test("original history path preserves explicit, XDG and home resolution", () => {
  assert.equal(opencodeV1DatabasePath({ OPENCODE_DB: "history/custom.db" }), resolve("history/custom.db"));
  assert.equal(opencodeV1DatabasePath({ XDG_DATA_HOME: "/profiles/xdg", HOME: "/profiles/home" }), "/profiles/xdg/opencode/opencode.db");
  assert.equal(opencodeV1DatabasePath({ HOME: "/profiles/home", OPENCODE_DB: "  " }), "/profiles/home/.local/share/opencode/opencode.db");
  assert.throws(() => opencodeV1DatabasePath({ OPENCODE_DB: ":memory:" }), /In-memory/);
});

test("missing separate database selects original without creating any files", async () => {
  await fixture(async (root, legacy, source) => {
    const before = await readdir(root);
    assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), source);
    assert.deepEqual(await readdir(root), before);
    assert.deepEqual(await readdir(legacy), []);
  });
});

test("zero-byte or initialized empty separate database does not hide original history", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await database(source, `${v1Schema} INSERT INTO session VALUES ('original', '/work', NULL);`);
    await writeFile(target, "");
    assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), source);
    await database(target, initializedSchema);
    await preserved(source, () => preserved(target, async () => {
      assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), source);
    }));
  });
});

test("populated separate database wins, including split history and completed copies", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await database(source, `${v1Schema} INSERT INTO session VALUES ('newer-v1-chat', '/work', NULL);`);
    await database(target, `${initializedSchema}
      INSERT INTO session_v2 VALUES ('native-v2-chat');
      CREATE TABLE openwork_history_copy (session_id TEXT, completed INTEGER);
      INSERT INTO openwork_history_copy VALUES ('copied-v1-chat', 1);`);
    await preserved(source, () => preserved(target, async () => {
      assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), target);
    }));
  });
});

test("an interrupted OpenWork copy never gates existing v2 history or discards chats", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await database(source, `${v1Schema} INSERT INTO session VALUES ('original', '/work', NULL);`);
    await database(target, `${initializedSchema}
      INSERT INTO session_v2 VALUES ('native-v2-chat'), ('partially-copied-chat');
      CREATE TABLE openwork_history_copy (session_id TEXT, completed INTEGER);
      INSERT INTO openwork_history_copy VALUES ('completed-chat', 1), ('partially-copied-chat', 0);`);
    await preserved(source, () => preserved(target, async () => {
      assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), target);
    }));
  });
});

test("an empty initialized store with stale checkpoints does not hide original history", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await database(target, `${initializedSchema}
      CREATE TABLE openwork_history_copy (session_id TEXT, completed INTEGER);
      INSERT INTO openwork_history_copy VALUES ('unfinished', 0);`);
    await preserved(target, async () => {
      assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), source);
    });
  });
});

test("upstream partial and completed in-place conversion markers are left to upstream", async () => {
  await fixture(async (_root, legacy, source) => {
    await database(source, `${v1Schema}
      INSERT INTO session VALUES ('original', '/work', NULL);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO kv VALUES ('migration.v1-v2', '{"phase":"sessions","cursor":"original"}');`);
    for (const state of ['{"phase":"sessions","cursor":"original"}', '{"phase":"completed"}']) {
      const db = await openDatabase(source);
      try { db.prepare("UPDATE kv SET value = ?").run(state); }
      finally { db.close(); }
      await preserved(source, async () => {
        assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), source);
      });
    }
  });
});

test("staging receipts and stale locks neither establish history nor get removed", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await database(target, initializedSchema);
    await mkdir(join(legacy, "history-migration"));
    const artifacts = ["history-copy.pending", "engine-lease-stale.json", "history-copy-mutex.db", "history-migration/stage.json"];
    for (const name of artifacts) await writeFile(join(legacy, name), "old build artifact");
    await preserved(target, async () => {
      assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), source);
    });
    for (const name of artifacts) assert.equal(await readFile(join(legacy, name), "utf8"), "old build artifact");
  });
});

test("unreadable existing history is not silently replaced by the original database", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await writeFile(target, "not a SQLite database");
    await preserved(target, async () => {
      await assert.rejects(resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }));
    });
  });
});

test("legacy sessions are not discarded if their database has not been converted yet", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    await database(target, `${v1Schema} INSERT INTO session VALUES ('old', '/work', NULL);`);
    await preserved(target, async () => {
      assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), target);
    });
  });
});

test("selection sees committed v2 history in WAL without checkpointing it", async () => {
  await fixture(async (_root, legacy, source) => {
    const target = join(legacy, "opencode.db");
    const db = await openDatabase(target);
    try {
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; ${initializedSchema}
        INSERT INTO session_v2 VALUES ('in-wal');`);
      await preserved(`${target}-wal`, () => preserved(target, async () => {
        assert.equal(await resolveOpencodeHistoryDatabase(legacy, { OPENCODE_DB: source }), target);
      }));
    } finally { db.close(); }
  });
});

test("session-home lookup only returns absolute top-level original chat directories", async () => {
  await fixture(async (_root, _legacy, source) => {
    assert.equal(await v1ChatDirectory(source, "missing"), null);
    await database(source, `${v1Schema}
      INSERT INTO session VALUES ('top', '/work/original', NULL),
        ('delegated', '/work/original', 'top'), ('relative', 'work/relative', NULL);`);
    await preserved(source, async () => {
      assert.equal(await v1ChatDirectory(source, "top"), "/work/original");
      assert.equal(await v1ChatDirectory(source, "delegated"), null);
      assert.equal(await v1ChatDirectory(source, "relative"), null);
      assert.equal(await v1ChatDirectory(source, "missing' OR 1=1 --"), null);
    });
  });
});
