import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { cp, link, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { createHeadlessThreadClientV2, createNativeV2Client } from "@openwork/headless-threads/v2";
import { withAbort } from "./collaboration.mjs";
import { coworkerIdentity } from "./event-execution.mjs";
import { assertMaintenanceSender, assertResetConfirmation, createMaintenance, createMaintenanceAdmission, createMaintenanceSteps, maintenanceHistoryScope, resolveMaintenanceHistoryDb, validateMaintenancePaths } from "./maintenance.mjs";
import { normalizeSettings, readSettings, updateSettings } from "./settings.mjs";
import { captureMaintenanceProcesses, maintenanceFailureDetail, maintenancePreparationFailure, maintenanceProcessIdentity, maintenanceLaunchArguments, prepareMaintenanceHandoff, readMaintenanceStartup, waitForMaintenanceExit as waitForCapturedExit } from "./maintenance-handoff.mjs";

const waitForMaintenanceExit = (pids, timeout) => waitForCapturedExit(captureMaintenanceProcesses(pids), timeout);
const sessionTables = ["session_message", "session_pending", "session_inbox", "instruction_entry", "instruction_state"];
const sharedTables = ["project", "project_directory", "worktree", "workspace", "permission", "credential", "account", "account_state", "control_account", "instruction_blob", "kv", "migration"];

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "coworker-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolated = path.join(root, "isolated");
  await mkdir(isolated);
  const config = {
    userData: path.join(isolated, "electron-userdata"), coworkers: path.join(isolated, "coworkers"),
    serverConfig: path.join(isolated, "coworker-server.json"), settings: path.join(isolated, "coworker-settings.json"),
    runtimeDb: path.join(isolated, "runtime.sqlite"), envStore: path.join(isolated, "coworker-env.json"),
    historyDb: resolveMaintenanceHistoryDb({ rootDir: path.join(isolated, "native-engine") }),
    defaults: { userData: path.join(root, "normal", "profile"), devUserData: path.join(root, "normal", "dev-profile"), coworkers: path.join(root, "shared", "coworkers"), serverConfig: path.join(root, "shared", "coworker-server.json") },
    protectedPaths: [root, path.join(root, "shared"), path.join(root, "credentials.json")], allowedParents: [root], isDev: true,
  };
  await mkdir(config.userData);
  await mkdir(path.join(config.coworkers, "writer"), { recursive: true });
  await writeFile(path.join(config.userData, "onboarding.json"), "old-onboarding");
  await writeFile(path.join(config.coworkers, "writer", "memory.md"), "kept in recovery");
  for (const file of [config.serverConfig, config.runtimeDb, `${config.runtimeDb}-wal`, `${config.runtimeDb}-shm`, config.envStore]) await writeFile(file, "fixture-state");
  await writeFile(path.join(root, "credentials.json"), "fixture-credential");
  await updateSettings(config.settings, { maxParallelLocalRuns: 7, progressSummariesEnabled: true, progressSummaryModelId: "fixture/summary" });
  await mkdir(path.dirname(config.historyDb));
  const db = new DatabaseSync(config.historyDb);
  // Independent disposable DDL from beta19086 core/database/schema.gen.ts,
  // including native indexes. No engine startup, migration or real auth storage.
  db.exec(`
    CREATE TABLE account_state (
      id INTEGER PRIMARY KEY, active_account_id TEXT, active_org_id TEXT,
      FOREIGN KEY (active_account_id) REFERENCES account(id) ON DELETE SET NULL
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
      token_expiry INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE control_account (
      email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, token_expiry INTEGER,
      active INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY(email, url)
    );
    CREATE TABLE credential (
      id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT,
      active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);
    CREATE TABLE event (
      id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, created INTEGER DEFAULT 0 NOT NULL,
      type TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY (aggregate_id) REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE
    );
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE permission (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
    CREATE TABLE project_directory (
      project_id TEXT NOT NULL, directory TEXT NOT NULL, type TEXT, strategy TEXT, time_created INTEGER NOT NULL,
      PRIMARY KEY(project_id, directory), FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT
    );
    CREATE TABLE instruction_blob (hash TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE instruction_entry (
      session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, removed INTEGER DEFAULT false NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY(session_id, key),
      FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE instruction_state (
      session_id TEXT PRIMARY KEY, epoch_start INTEGER NOT NULL, through_seq INTEGER NOT NULL,
      initial_values TEXT NOT NULL, current_values TEXT NOT NULL, FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE session_inbox (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, delivery TEXT NOT NULL,
      enqueued_seq INTEGER NOT NULL, time_created INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE session_pending (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, delivery TEXT,
      admitted_seq INTEGER NOT NULL, time_created INTEGER NOT NULL, FOREIGN KEY (session_id) REFERENCES session_v2(id) ON DELETE CASCADE
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT,
      summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT,
      cost REAL DEFAULT 0 NOT NULL, tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
      tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL, tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
      revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER,
      time_suspended INTEGER, resume_attempts INTEGER DEFAULT 0 NOT NULL, FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
    CREATE TABLE workspace (id TEXT PRIMARY KEY, provider TEXT NOT NULL, binding TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
    CREATE TABLE worktree (
      project_id TEXT NOT NULL, directory TEXT NOT NULL, strategy TEXT, time_created INTEGER NOT NULL,
      PRIMARY KEY(project_id, directory), FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
    );
    CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
    CREATE UNIQUE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq);
    CREATE INDEX event_aggregate_type_seq_idx ON event(aggregate_id, type, seq);
    CREATE UNIQUE INDEX permission_project_action_resource_idx ON permission(project_id, action, resource);
    CREATE INDEX session_inbox_session_delivery_seq_idx ON session_inbox(session_id, delivery, enqueued_seq);
    CREATE UNIQUE INDEX session_inbox_session_enqueued_seq_idx ON session_inbox(session_id, enqueued_seq);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
    CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
    CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id, time_created, id);
    CREATE INDEX session_message_time_created_idx ON session_message(time_created);
    CREATE INDEX session_pending_session_delivery_seq_idx ON session_pending(session_id, delivery, admitted_seq);
    CREATE UNIQUE INDEX session_pending_session_compaction_idx ON session_pending(session_id) WHERE "session_pending"."type" = 'compaction';
    CREATE UNIQUE INDEX session_pending_session_admitted_seq_idx ON session_pending(session_id, admitted_seq);
    CREATE INDEX session_v2_project_idx ON session_v2(project_id);
    CREATE INDEX session_v2_workspace_idx ON session_v2(workspace_id);
    CREATE INDEX session_v2_parent_idx ON session_v2(parent_id);
    CREATE INDEX session_v2_time_suspended_idx ON session_v2(time_suspended) WHERE "session_v2"."time_suspended" IS NOT NULL;
    INSERT INTO project(id, worktree, name, time_created, time_updated, sandboxes) VALUES ('project', '/fixture', 'sentinel', 1, 1, '[]');
    INSERT INTO project_directory VALUES ('project', '/fixture', 'main', NULL, 1);
    INSERT INTO worktree VALUES ('project', '/fixture', NULL, 1);
    INSERT INTO workspace VALUES ('workspace', 'fixture', 'sentinel', 1, 1);
    INSERT INTO account VALUES ('account', 'fixture@example.invalid', 'https://example.invalid', 'fixture-credential', 'fixture-refresh', NULL, 1, 1);
    INSERT INTO account_state VALUES (1, 'account', 'fixture-org');
    INSERT INTO control_account VALUES ('fixture@example.invalid', 'https://example.invalid', 'fixture-control', 'fixture-refresh', NULL, 1, 1, 1);
    INSERT INTO credential(id, label, value, time_created, time_updated) VALUES ('foreign', 'fixture', 'preserved-credential', 1, 1);
    INSERT INTO permission VALUES ('permission', 'project', 'fixture', 'sentinel', 1, 1);
    INSERT INTO instruction_blob VALUES ('shared-hash', '{"text":"shared instruction"}');
    INSERT INTO kv VALUES ('fixture', '{"sentinel":true}', 1, 1);
    INSERT INTO migration VALUES ('20260823191254_nullable_workspace_binding', 1);
  `);
  for (const [id, directory] of [["owned", path.join(config.coworkers, "writer")], ["neighbor", `${config.coworkers}-other/writer`], ["unrelated", path.join(root, "another-project")]]) {
    db.prepare("INSERT INTO session_v2(id, directory, project_id, slug, version, time_created, time_updated) VALUES (?, ?, 'project', ?, 'beta19086', 1, 1)").run(id, directory, id);
    db.prepare("INSERT INTO session_message VALUES (?, ?, 'user', 1, 1, 1, ?)").run(`msg-${id}`, id, JSON.stringify({ text: `message-${id}` }));
    db.prepare("INSERT INTO session_pending VALUES (?, ?, 'user', '{}', 'queued', 2, 1)").run(`pending-${id}`, id);
    db.prepare("INSERT INTO session_inbox VALUES (?, ?, 'user', '{}', 'queued', 3, 1)").run(`inbox-${id}`, id);
    db.prepare("INSERT INTO instruction_entry VALUES (?, 'fixture', '\"shared-hash\"', false, 1, 1)").run(id);
    db.prepare("INSERT INTO instruction_state VALUES (?, 0, 1, '{}', '{}')").run(id);
    db.prepare("INSERT INTO event_sequence VALUES (?, 1, 'fixture-owner')").run(id);
    db.prepare("INSERT INTO event VALUES (?, ?, 1, 1, 'session.created', ?)").run(`event-${id}`, id, JSON.stringify({ sessionID: id }));
  }
  // Aggregates without a session are not implicitly owned by this reset.
  db.exec("INSERT INTO event_sequence VALUES ('unprojected', 1, NULL); INSERT INTO event VALUES ('event-unprojected', 'unprojected', 1, 1, 'session.created', '{}')");
  const preserved = Object.fromEntries(sharedTables.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
  db.close();
  const admission = createMaintenanceAdmission();
  let relaunched = false;
  const service = createMaintenance({ admission, paths: () => validateMaintenancePaths(config), coworkerCount: async () => 1,
    stop: async () => true, relaunch: async () => { relaunched = true; },
    restoreDefaults: () => updateSettings(config.settings, normalizeSettings({})), ...overrides });
  return { root, config, admission, service, preserved, relaunched: () => relaunched };
}

test("reset backs up and removes only Coworker files, sessions and event aggregates, then relaunches", async (t) => {
  const f = await fixture(t);
  const seed = new DatabaseSync(f.config.historyDb);
  seed.prepare("INSERT INTO session_v2(id, directory, parent_id, project_id, slug, version, time_created, time_updated) VALUES ('owned-child', ?, 'owned', 'project', 'child', 'beta19086', 1, 1)").run(path.join(f.config.coworkers, "writer"));
  seed.close();
  const legacyPath = path.join(f.root, "legacy-v1.db");
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message(id TEXT, session_id TEXT, data TEXT)");
  legacy.prepare("INSERT INTO session VALUES ('owned', ?)").run(path.join(f.config.coworkers, "writer"));
  legacy.exec("INSERT INTO message VALUES ('v1-message', 'owned', 'original v1 history')");
  legacy.close();
  const legacyBytes = await readFile(legacyPath);
  assert.deepEqual(await f.service.preview(), { coworkerCount: 1, historyCount: 2, backupDirectory: `${f.config.userData}-recovery` });
  const { backupPath } = await f.service.factoryReset({ confirmation: "DELETE" });
  assert.equal(f.relaunched(), true);
  await assert.rejects(stat(f.config.userData), { code: "ENOENT" });
  await assert.rejects(stat(f.config.coworkers), { code: "ENOENT" });
  await assert.rejects(stat(`${f.config.runtimeDb}-wal`), { code: "ENOENT" });
  assert.equal(await readFile(path.join(backupPath, "files", "coworkers", "writer", "memory.md"), "utf8"), "kept in recovery");
  assert.equal(await readFile(path.join(backupPath, "originals", "profile", "onboarding.json"), "utf8"), "old-onboarding");
  assert.equal(await readFile(path.join(f.root, "credentials.json"), "utf8"), "fixture-credential");
  assert.deepEqual(await readFile(legacyPath), legacyBytes, "Existing v1 history is neither changed nor relocated.");
  assert.equal((await stat(backupPath)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(backupPath, "history.sqlite"))).mode & 0o777, 0o600);
  const db = new DatabaseSync(f.config.historyDb);
  const backup = new DatabaseSync(path.join(backupPath, "history.sqlite"));
  try {
    assert.deepEqual(db.prepare("SELECT id FROM session_v2 ORDER BY id").all().map((row) => row.id), ["neighbor", "unrelated"]);
    assert.deepEqual(db.prepare("SELECT aggregate_id FROM event ORDER BY aggregate_id").all().map((row) => row.aggregate_id), ["neighbor", "unprojected", "unrelated"]);
    for (const name of sharedTables) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${name}`).all(), f.preserved[name]);
      assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = ?").get(name).n, 0);
    }
    assert.deepEqual(backup.prepare("SELECT id FROM session_v2 ORDER BY id").all().map((row) => row.id), ["owned", "owned-child"]);
    for (const table of sessionTables) {
      assert.deepEqual(db.prepare(`SELECT session_id FROM ${table} ORDER BY session_id`).all().map((row) => row.session_id), ["neighbor", "unrelated"]);
      assert.deepEqual(backup.prepare(`SELECT session_id FROM ${table}`).all().map((row) => row.session_id), ["owned"]);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(backup.prepare("SELECT data FROM session_message").get().data, JSON.stringify({ text: "message-owned" }));
    assert.equal(backup.prepare("SELECT count(*) AS n FROM event").get().n, 1);
  } finally { db.close(); backup.close(); }
  await assert.rejects(f.admission.run(() => mkdir(f.config.coworkers)), /Fresh start/);
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /Fresh start/);
});

test("native confirmation and exact main-frame ownership reject untrusted requests", async (t) => {
  const f = await fixture(t);
  for (const confirmation of ["delete", " DELETE", "DELETE ", true]) await assert.rejects(f.service.factoryReset({ confirmation }), /Type DELETE exactly/);
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE", path: f.root }), /Type DELETE/);
  assert.equal(f.admission.closed, false);
  const frame = { url: "file:///app/index.html#settings" };
  const contents = { mainFrame: frame };
  assertMaintenanceSender({ sender: contents, senderFrame: frame }, contents, "file:///app/index.html");
  for (const event of [{ sender: contents, senderFrame: { url: frame.url } }, { sender: {}, senderFrame: frame }]) assert.throws(() => assertMaintenanceSender(event, contents, "file:///app/index.html"), /trusted.*main frame/);
  assert.throws(() => assertMaintenanceSender({ sender: contents, senderFrame: frame }, contents, "file:///other/index.html"), /trusted/);
});

test("backup and uncertain native stop failures never remove files or history", async (t) => {
  for (const overrides of [{ stop: async () => false }, { stop: async () => { throw new Error("Unconfirmed engine stop"); } }, { copy: async () => { throw new Error("Backup disk unavailable"); } }, { copy: async () => {} }]) {
    const f = await fixture(t, overrides);
    await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /preserved/);
    if (overrides.stop) await assert.rejects(stat(`${f.config.userData}-recovery`), { code: "ENOENT" });
    assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
    const db = new DatabaseSync(f.config.historyDb);
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3); } finally { db.close(); }
    assert.equal(f.relaunched(), false);
  }
});

test("a move failure rolls files and history back without overwriting a newly created path", async (t) => {
  for (const recreate of [false, true]) {
    let moves = 0;
    let profile;
    const f = await fixture(t, { move: async (source, destination) => {
      if (++moves === 2) {
        if (recreate) { await mkdir(profile); await writeFile(path.join(profile, "new"), "sentinel"); }
        throw new Error("Move failed");
      }
      return rename(source, destination);
    } });
    profile = f.config.userData;
    await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), recreate ? /recovery needs attention/ : /preserved/);
    assert.equal(await readFile(path.join(profile, recreate ? "new" : "onboarding.json"), "utf8"), recreate ? "sentinel" : "old-onboarding");
    const db = new DatabaseSync(f.config.historyDb);
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3); } finally { db.close(); }
    assert.equal(f.relaunched(), false);
  }
});

test("ambiguous paths, outside descendants, forks and schema drift fail closed", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ userData: f.root }, { coworkers: f.config.userData }, { runtimeDb: path.join(f.root, "shared", "runtime.sqlite") }, { historyDb: path.join(f.config.userData, "opencode.db") }]) await assert.rejects(validateMaintenancePaths({ ...f.config, ...patch }));
  const link = path.join(f.root, "opencode.db");
  await symlink(f.config.historyDb, link);
  await assert.rejects(validateMaintenancePaths({ ...f.config, historyDb: link }), /symlink/);
  for (const sql of [
    "UPDATE session_v2 SET parent_id = 'owned' WHERE id = 'unrelated'",
    "UPDATE session_v2 SET fork_session_id = 'owned' WHERE id = 'unrelated'",
    "CREATE TABLE new_history(session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE)",
  ]) {
    const db = new DatabaseSync(f.config.historyDb);
    db.exec(sql); db.close();
    await assert.rejects(f.service.preview(), /Reset refused/);
    const repair = new DatabaseSync(f.config.historyDb);
    repair.exec("UPDATE session_v2 SET parent_id = NULL, fork_session_id = NULL; DROP TABLE IF EXISTS new_history");
    repair.close();
  }
});

test("unknown schemas fail reset before shutdown, backup, or deletion", async (t) => {
  for (const sql of [
    "CREATE TABLE unknown_records(id TEXT)",
    "CREATE TABLE sqliteXforeign(session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE)",
    "DROP TABLE session_inbox",
    "CREATE TRIGGER leak AFTER DELETE ON session_v2 BEGIN DELETE FROM account; END",
    "CREATE VIEW unknown_history AS SELECT * FROM session_v2",
    "UPDATE session_v2 SET parent_id = 'owned' WHERE id = 'unrelated'",
    "UPDATE session_v2 SET fork_session_id = 'owned' WHERE id = 'unrelated'",
    "ALTER TABLE session_pending ADD COLUMN future_owner TEXT",
    "ALTER TABLE event RENAME COLUMN created TO unknown_created",
    "DROP INDEX session_message_session_seq_idx",
    "CREATE INDEX unknown_owner ON session_v2(directory COLLATE NOCASE)",
    "DROP INDEX session_pending_session_compaction_idx; CREATE UNIQUE INDEX session_pending_session_compaction_idx ON session_pending(session_id) WHERE session_pending.type = 'synthetic'",
    "ALTER TABLE credential ADD COLUMN session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE",
    "DROP TABLE instruction_state; CREATE TABLE instruction_state(session_id TEXT PRIMARY KEY REFERENCES session_v2(id), epoch_start INTEGER NOT NULL, through_seq INTEGER NOT NULL, initial_values TEXT NOT NULL, current_values TEXT NOT NULL)",
    "CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT); INSERT INTO session VALUES ('v1', '/fixture')",
  ]) {
    let stopped = false;
    const f = await fixture(t, { stop: async () => { stopped = true; return true; } });
    const db = new DatabaseSync(f.config.historyDb);
    db.exec(sql); db.close();
    await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /preserved/);
    assert.equal(stopped, false);
    assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
    await assert.rejects(stat(`${f.config.userData}-recovery`), { code: "ENOENT" });
    const check = new DatabaseSync(f.config.historyDb);
    try {
      assert.equal(check.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3);
      assert.equal(check.prepare("SELECT access_token FROM account").get().access_token, "fixture-credential");
      if (sql.startsWith("CREATE TABLE session(")) assert.equal(check.prepare("SELECT id FROM session").get().id, "v1");
    } finally { check.close(); }
  }
});

test("an explicit native path containing only v1 history is refused without changing or relocating it", async (t) => {
  let stopped = false;
  const f = await fixture(t, { stop: async () => { stopped = true; return true; } });
  await rm(f.config.historyDb);
  const db = new DatabaseSync(f.config.historyDb);
  db.exec("CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT); INSERT INTO session VALUES ('v1', '/fixture')");
  db.close();
  const original = await readFile(f.config.historyDb);
  await assert.rejects(f.service.preview(), /Reset refused/);
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /preserved/);
  assert.equal(stopped, false);
  assert.deepEqual(await readFile(f.config.historyDb), original);
  assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
  await assert.rejects(stat(`${f.config.userData}-recovery`), { code: "ENOENT" });
});

test("a failed history commit restores the moved files and deleted rows", async (t) => {
  let attemptedCommit = false;
  const f = await fixture(t, { openDatabase: async (file, readOnly) => {
    const db = new DatabaseSync(file, { readOnly, enableForeignKeyConstraints: true });
    return { prepare: (sql) => db.prepare(sql), close: () => db.close(), exec: (sql) => {
      if (sql === "COMMIT" && !readOnly) { attemptedCommit = true; throw new Error("Injected commit failure"); }
      return db.exec(sql);
    } };
  } });
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /preserved.*Injected commit failure/);
  assert.equal(attemptedCommit, true);
  assert.equal(f.relaunched(), false);
  assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
  assert.equal(await readFile(path.join(f.config.coworkers, "writer", "memory.md"), "utf8"), "kept in recovery");
  const db = new DatabaseSync(f.config.historyDb);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM event").get().n, 4);
    for (const table of sessionTables) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 3);
    for (const table of sharedTables) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), f.preserved[table]);
  } finally { db.close(); }
});

test("single-flight reset drains a real late writer before backup and closes queued admission", async (t) => {
  const stopping = Promise.withResolvers();
  const reachedStop = Promise.withResolvers();
  let stops = 0;
  const f = await fixture(t, { stop: async () => { stops++; reachedStop.resolve(); await stopping.promise; return true; } });
  const writerReady = Promise.withResolvers();
  const releaseWriter = Promise.withResolvers();
  const writer = f.admission.run(async () => {
    writerReady.resolve();
    await releaseWriter.promise;
    await writeFile(path.join(f.config.coworkers, "writer", "late.md"), "last admitted write");
  });
  await writerReady.promise;
  const queued = f.admission.run(() => writeFile(path.join(f.config.userData, "must-not-start"), "wrong"));
  const reset = f.service.factoryReset({ confirmation: "DELETE" });
  await assert.rejects(queued, /Fresh start/);
  await reachedStop.promise;
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /Fresh start/);
  assert.equal(stops, 1);
  stopping.resolve();
  let finished = false;
  void reset.then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(finished, false);
  releaseWriter.resolve(); await writer;
  const { backupPath } = await reset;
  assert.equal(await readFile(path.join(backupPath, "files", "coworkers", "writer", "late.md"), "utf8"), "last admitted write");
  await assert.rejects(f.admission.run(() => mkdir(f.config.coworkers)), /Fresh start/);
  await new Promise(setImmediate);
  await assert.rejects(stat(f.config.coworkers), { code: "ENOENT" });
});

test("path overrides cannot enter protected trees, recovery, hard links, or symlinked homes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(validateMaintenancePaths({ ...f.config, serverConfig: path.join(path.parse(f.root).root, "coworker-server.json") }), /shared\/development/);
  const protectedRoot = path.join(f.root, "other-app");
  await assert.rejects(validateMaintenancePaths({ ...f.config, userData: path.join(protectedRoot, "electron-userdata"), protectedPaths: [...f.config.protectedPaths, protectedRoot] }), /shared storage/);
  await assert.rejects(validateMaintenancePaths({ ...f.config, historyDb: path.join(`${f.config.userData}-recovery`, "opencode.db") }), /recovery directory/);
  await assert.rejects(validateMaintenancePaths({ ...f.config, historyDb: path.join(f.root, "shared", "opencode.db") }), /protected or legacy/);
  await link(path.join(f.root, "credentials.json"), path.join(f.config.userData, "credential-link"));
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /shared hard link/);
  assert.equal(await readFile(path.join(f.root, "credentials.json"), "utf8"), "fixture-credential");
  const other = await fixture(t);
  const linked = path.join(other.config.coworkers, "linked");
  await symlink(other.root, linked);
  const db = new DatabaseSync(other.config.historyDb);
  db.prepare("UPDATE session_v2 SET directory = ? WHERE id = 'owned'").run(linked); db.close();
  await assert.rejects(other.service.factoryReset({ confirmation: "DELETE" }), /symlinked/);
});

test("a missing history database stays absent during preview and reset", async (t) => {
  const f = await fixture(t);
  await rm(f.config.historyDb);
  assert.equal((await f.service.preview()).historyCount, 0);
  await assert.rejects(stat(f.config.historyDb), { code: "ENOENT" });
  const { backupPath } = await f.service.factoryReset({ confirmation: "DELETE" });
  assert.equal(JSON.parse(await readFile(path.join(backupPath, "manifest.json"), "utf8")).historyCount, 0);
  await assert.rejects(stat(f.config.historyDb), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.root, "credentials.json"), "utf8"), "fixture-credential");
});

test("reset waits for admitted writes and restoring defaults changes only app preferences", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.restoreDefaults(), normalizeSettings({}));
  assert.deepEqual(await readSettings(f.config.settings), normalizeSettings({}));
  assert.equal(await readFile(f.config.envStore, "utf8"), "fixture-state");
  assert.equal(await readFile(path.join(f.config.coworkers, "writer", "memory.md"), "utf8"), "kept in recovery");
  assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
  const db = new DatabaseSync(f.config.historyDb);
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3);
    assert.equal(db.prepare("SELECT access_token FROM account").get().access_token, "fixture-credential");
  } finally { db.close(); }
  let release;
  const pending = f.admission.run(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  f.admission.close();
  await assert.rejects(f.admission.drain(1), /did not finish/);
  release(); await pending;
  await f.admission.drain();
});

async function eventually(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("The isolated maintenance process did not finish in time.");
}

test("post-exit helper waits for parent AND late writer, then resets or rolls back and relaunches with a truthful receipt", async (t) => {
  for (const failBackup of [false, true]) {
    const f = await fixture(t);
    const parent = spawn(process.execPath, [fileURLToPath(new URL("./maintenance-process.fixture.mjs", import.meta.url)), "parent"], {
      stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, COWORKER_TEST_INHERITED: "fixture-env-preserved" },
    });
    let prepared;
    try {
      const ready = once(parent, "message");
      parent.send({ root: f.root, scope: f.config });
      [prepared] = await ready;
      const blocked = readMaintenanceStartup(f.config.userData);
      assert.equal(blocked.blocked, true, "A competing app cannot open the original profile during handoff.");
      if (failBackup) await link(path.join(f.root, "credentials.json"), path.join(f.config.userData, "shared-hardlink"));
      const exited = once(parent, "exit");
      parent.send({ type: "go" });
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
      await assert.rejects(stat(path.join(f.root, "relaunched.json")), { code: "ENOENT" });
      const before = new DatabaseSync(f.config.historyDb);
      try { assert.equal(before.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3); } finally { before.close(); }
      await writeFile(path.join(f.root, "release-writer"), "release only this fixture");
      await eventually(async () => { try { await stat(path.join(f.root, "relaunched.json")); return true; } catch { return false; } });
      const launched = JSON.parse(await readFile(path.join(f.root, "relaunched.json"), "utf8"));
      assert.equal(launched.notice.blocked, false);
      assert.equal(launched.notice.phase, failBackup ? "failed" : "completed");
      if (failBackup) {
        assert.deepEqual(launched.notice.diagnostics, { stage: "copying", code: "SHARED_HARDLINK" });
        assert.match(maintenanceFailureDetail(launched.notice.diagnostics), /backing up.*hard link/);
        assert.equal(maintenanceFailureDetail({ stage: "private-path", code: "private-error" }), "");
      }
      assert.equal(launched.marker, "fixture-env-preserved");
      assert.equal(launched.runAsNode, null);
      assert.equal(launched.args.some((arg) => /discard|stale/.test(arg)), false);
      assert.equal(readMaintenanceStartup(f.config.userData), null, "The notice is consumed once, not replayed on every start.");
      const db = new DatabaseSync(f.config.historyDb);
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, failBackup ? 3 : 2);
        assert.equal(db.prepare("SELECT value FROM credential").get().value, "preserved-credential");
      } finally { db.close(); }
      const previousProfile = failBackup ? f.config.userData : path.join(launched.notice.backupPath, "files", "profile");
      assert.equal(await readFile(path.join(previousProfile, "late-writer"), "utf8"), "written before Chromium witness exit");
      assert.equal(await readFile(path.join(f.root, "credentials.json"), "utf8"), "fixture-credential");
    } finally {
      await writeFile(path.join(f.root, "release-writer"), "release");
      if (parent.exitCode === null) { parent.kill("SIGTERM"); await once(parent, "exit"); }
      if (prepared) await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 8000);
    }
  }
});

test("helper preparation rejects confirmation, spawn failure, wrong nonce, and replay without deleting data", async (t) => {
  const f = await fixture(t);
  const options = { scope: f.config, executable: await realpath(process.env.COWORKER_TEST_HELPER_EXECUTABLE ?? process.execPath),
    helperPath: process.env.COWORKER_TEST_HELPER_PATH ?? fileURLToPath(new URL("./maintenance-helper.mjs", import.meta.url)), args: ["unused-fixture.mjs"] };
  await assert.rejects(prepareMaintenanceHandoff({ ...options, input: { confirmation: "delete" } }), /Type DELETE/);
  await assert.rejects(prepareMaintenanceHandoff({ ...options, input: { confirmation: "DELETE" }, executable: path.join(f.root, "missing-executable") }));
  const cli = spawn(options.executable, [options.helperPath, f.config.userData], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal((await once(cli, "exit"))[0], 1, "CLI paths cannot authorize a reset.");
  assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
  assert.deepEqual(maintenanceLaunchArguments(["app.mjs", "--inspect=9229", "opencoworker://discard", "--fresh-start=old"]), ["app.mjs", "--inspect=9229"]);
  const raw = spawn(options.executable, [options.helperPath], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const ticket = randomBytes(32).toString("hex");
  const ready = once(raw, "message");
  raw.send({ type: "prepare", ticket, parentPid: process.pid, scope: f.config, launch: { executable: options.executable, cwd: process.cwd(), args: options.args } });
  assert.equal((await ready)[0].type, "ready");
  raw.send({ type: "arm", ticket: randomBytes(32).toString("hex"), previousProcesses: captureMaintenanceProcesses([process.pid]) });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(JSON.parse(await readFile(path.join(`${f.config.userData}-recovery`, "pending-reset.json"), "utf8")).phase, "prepared");
  const rawExit = once(raw, "exit");
  raw.send({ type: "cancel", ticket });
  await rawExit;
  const handoff = await prepareMaintenanceHandoff({ ...options, input: { confirmation: "DELETE" } });
  try {
    await assert.rejects(prepareMaintenanceHandoff({ ...options, input: { confirmation: "DELETE" } }), /refused|disconnected/);
    await handoff.cancel();
    await waitForMaintenanceExit([handoff.pid], 5000);
    await assert.rejects(handoff.arm([]), /closed|channel|disconnected|cancelled/i);
    await assert.rejects(handoff.arm([]), /already consumed/);
  } finally { await handoff.cancel(); }
  assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
});

test("a helper exit timeout never erases files and relaunches into a native cleanup error", async (t) => {
  const f = await fixture(t);
  const parent = spawn(process.execPath, [fileURLToPath(new URL("./maintenance-process.fixture.mjs", import.meta.url)), "parent"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let prepared;
  try {
    const ready = once(parent, "message");
    parent.send({ root: f.root, scope: f.config, timeout: true });
    [prepared] = await ready;
    const exited = once(parent, "exit");
    parent.send({ type: "go" });
    await exited;
    await eventually(async () => { try { await stat(path.join(f.root, "relaunched.json")); return true; } catch { return false; } });
    const launched = JSON.parse(await readFile(path.join(f.root, "relaunched.json"), "utf8"));
    assert.equal(launched.notice.blocked, true);
    assert.match(launched.notice.message, /without confirmed cleanup/);
    assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
    const db = new DatabaseSync(f.config.historyDb);
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3); } finally { db.close(); }
    await writeFile(path.join(f.root, "release-writer"), "release");
    await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 5000);
    assert.deepEqual(readMaintenanceStartup(f.config.userData, { consume: false }), { blocked: false, phase: "failed", backupPath: null, diagnostics: { stage: "waiting-for-exit" } });
    assert.deepEqual(readMaintenanceStartup(f.config.userData), { blocked: false, phase: "failed", backupPath: null, diagnostics: { stage: "waiting-for-exit" } });
    assert.equal(readMaintenanceStartup(f.config.userData), null);
  } finally {
    await writeFile(path.join(f.root, "release-writer"), "release");
    if (parent.exitCode === null) { parent.kill("SIGTERM"); await once(parent, "exit"); }
    if (prepared) await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 5000);
  }
});

test("an OS relaunch failure retains the completed backup and a one-time native error for manual reopening", async (t) => {
  const f = await fixture(t);
  const launchCwd = path.join(f.root, "launch-cwd");
  await mkdir(launchCwd);
  const parent = spawn(process.execPath, [fileURLToPath(new URL("./maintenance-process.fixture.mjs", import.meta.url)), "parent"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let prepared;
  try {
    const ready = once(parent, "message");
    parent.send({ root: f.root, scope: f.config, launchCwd });
    [prepared] = await ready;
    await rm(launchCwd, { recursive: true });
    const exited = once(parent, "exit");
    parent.send({ type: "go" });
    await exited;
    await writeFile(path.join(f.root, "release-writer"), "release");
    await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 8000);
    const result = readMaintenanceStartup(f.config.userData);
    assert.equal(result.phase, "completed");
    assert.equal(result.relaunchFailed, true);
    assert.equal(result.blocked, false);
    assert.equal(await readFile(path.join(result.backupPath, "files", "profile", "onboarding.json"), "utf8"), "old-onboarding");
    assert.equal(readMaintenanceStartup(f.config.userData), null);
  } finally {
    await writeFile(path.join(f.root, "release-writer"), "release");
    if (parent.exitCode === null) { parent.kill("SIGTERM"); await once(parent, "exit"); }
    if (prepared) await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 8000);
  }
});

test("lost/delayed acknowledgements and missing final commitment cannot turn ordinary quit into reset", async (t) => {
  for (const mode of ["lost-armed", "delayed-armed", "lost-committed", "no-commit"]) {
    const f = await fixture(t);
    const parent = spawn(process.execPath, [fileURLToPath(new URL("./maintenance-process.fixture.mjs", import.meta.url)), "parent"], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let prepared;
    try {
      const ready = once(parent, "message");
      parent.send({ root: f.root, scope: f.config, ...(mode === "no-commit" ? { noCommit: true } : { ackFault: mode }) });
      [prepared] = await ready;
      const exited = once(parent, "exit");
      if (mode !== "no-commit") {
        const cancelled = once(parent, "message");
        parent.send({ type: "go" });
        assert.equal((await cancelled)[0].type, "cancelled");
        assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
        parent.send({ type: "ordinary-quit" });
      } else parent.send({ type: "go" });
      await exited;
      await writeFile(path.join(f.root, "release-writer"), "release");
      await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 8000);
      assert.equal(await readFile(path.join(f.config.userData, "late-writer"), "utf8"), "written before Chromium witness exit");
      await assert.rejects(stat(path.join(f.root, "relaunched.json")), { code: "ENOENT" });
      const db = new DatabaseSync(f.config.historyDb);
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3);
        assert.equal(db.prepare("SELECT value FROM credential").get().value, "preserved-credential");
      } finally { db.close(); }
    } finally {
      await writeFile(path.join(f.root, "release-writer"), "release");
      if (parent.exitCode === null) { parent.kill("SIGTERM"); await once(parent, "exit"); }
      if (prepared) await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 8000);
    }
  }
});

test("persisted boot/start identities ignore reused PIDs but retain the partial-mutation guard", async (t) => {
  const f = await fixture(t);
  const directory = `${f.config.userData}-recovery`;
  await mkdir(directory, { mode: 0o700 });
  const current = maintenanceProcessIdentity(process.pid);
  const ticket = randomBytes(32).toString("hex");
  const pending = path.join(directory, "pending-reset.json");
  for (const helper of [{ ...current, boot: "previous-boot" }, { ...current, started: "previous-process" }]) {
    await writeFile(pending, JSON.stringify({ version: 2, ticket, helper, previousProcesses: [helper], phase: "armed", backupPath: null }), { mode: 0o600 });
    assert.equal(readMaintenanceStartup(f.config.userData).blocked, false);
    await writeFile(pending, JSON.stringify({ version: 2, ticket, helper, previousProcesses: [helper], phase: "resetting", backupPath: null }), { mode: 0o600 });
    assert.equal(readMaintenanceStartup(f.config.userData).blocked, true);
    await rm(pending);
    await writeFile(path.join(directory, "reset-result.json"), JSON.stringify({ version: 2, ticket, previousProcesses: [helper], phase: "failed", backupPath: null, recoveryRequired: false }), { mode: 0o600 });
    assert.equal(readMaintenanceStartup(f.config.userData).blocked, false);
  }
});

test("large file backup does not hold the shared database write lock", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let copies = 0;
  const f = await fixture(t, { copy: async (source, destination) => {
    if (++copies === 1) { entered.resolve(); await release.promise; }
    await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false });
  } });
  const reset = f.service.factoryReset({ confirmation: "DELETE" });
  void reset.catch(() => {});
  try {
    await entered.promise;
    const other = new DatabaseSync(f.config.historyDb, { timeout: 50 });
    try { other.exec("BEGIN IMMEDIATE; UPDATE credential SET value = 'concurrent-preserved'; COMMIT;"); }
    finally { other.close(); }
  } finally { release.resolve(); await reset; }
  const check = new DatabaseSync(f.config.historyDb);
  try { assert.equal(check.prepare("SELECT value FROM credential").get().value, "concurrent-preserved"); } finally { check.close(); }
});

test("engine database selection requires the explicit native v2 root or matching database path", () => {
  const input = { rootDir: "/isolated/native", platform: "linux" };
  assert.equal(resolveMaintenanceHistoryDb(input), "/isolated/native/opencode.db");
  assert.equal(resolveMaintenanceHistoryDb({ ...input, databasePath: "/isolated/native/opencode.db" }), "/isolated/native/opencode.db");
  assert.equal(resolveMaintenanceHistoryDb({ databasePath: "/isolated/native/opencode.db", platform: "linux" }), "/isolated/native/opencode.db");
  assert.throws(() => resolveMaintenanceHistoryDb(), /unresolved/);
  assert.throws(() => resolveMaintenanceHistoryDb({ env: { OPENCODE_DB: "/legacy/opencode.db" }, dataDirectory: "/legacy", bundled: true, version: "1.18.18" }), /unresolved/);
  for (const rootDir of [null, "", "/", ":memory:", "relative", " /isolated/native", "/isolated/../native", "/isolated/native\0"]) {
    assert.throws(() => resolveMaintenanceHistoryDb({ ...input, rootDir }), /filesystem/);
  }
  for (const databasePath of ["/other/opencode.db", "/isolated/native/legacy.db", "/opencode.db"]) {
    assert.throws(() => resolveMaintenanceHistoryDb({ ...input, databasePath }), /rootDir\/opencode.db/);
  }
  assert.equal(resolveMaintenanceHistoryDb({ rootDir: "C:\\fixture\\native", platform: "win32" }), "C:\\fixture\\native\\opencode.db");
  assert.equal(resolveMaintenanceHistoryDb({ databasePath: "\\\\host.example\\share\\native\\opencode.db", platform: "win32" }), "\\\\host.example\\share\\native\\opencode.db");
  for (const rootDir of ["C:relative", "\\native", "C:\\", "C:/fixture/native", "\\\\?\\C:\\fixture"]) {
    assert.throws(() => resolveMaintenanceHistoryDb({ rootDir, platform: "win32" }), /filesystem/);
  }
});

test("a source directory replaced after pre-copy is not moved or overwritten during rollback", async (t) => {
  let profile;
  const f = await fixture(t, { beforeMutation: async () => {
    await rename(profile, `${profile}-previous`);
    await mkdir(profile);
    await writeFile(path.join(profile, "new-setup"), "preserve replacement");
  } });
  profile = f.config.userData;
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /source path changed/i);
  assert.equal(await readFile(path.join(profile, "new-setup"), "utf8"), "preserve replacement");
  assert.equal(await readFile(path.join(`${profile}-previous`, "onboarding.json"), "utf8"), "old-onboarding");
  const db = new DatabaseSync(f.config.historyDb);
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM session_v2").get().n, 3); } finally { db.close(); }
  assert.equal(f.relaunched(), false);
});

test("Windows engine directory queries use serialized slashes without accepting aliases or neighbors", () => {
  const scope = maintenanceHistoryScope("C:\\Users\\fixture\\coworkers", "win32");
  assert.equal(scope.directory, "C:/Users/fixture/coworkers");
  assert.equal(scope.prefix, "C:/Users/fixture/coworkers/");
  assert.equal(scope.nativeDirectory("C:/Users/fixture/coworkers/writer"), "C:\\Users\\fixture\\coworkers\\writer");
  assert.equal(scope.nativeDirectory("C:/Users/fixture/coworkers-other/writer"), null);
  assert.equal(maintenanceHistoryScope("C:\\Users\\fixture\\coworkers\\", "win32").prefix, scope.prefix);
  for (const alias of ["C:/Users/fixture/coworkers/../other", "C:/Users/fixture/coworkers/./writer", "C:\\Users\\fixture\\coworkers\\writer", "c:/Users/fixture/coworkers/writer"]) assert.throws(() => scope.nativeDirectory(alias), /ambiguous/);
  const unc = maintenanceHistoryScope("\\\\host\\share\\coworkers", "win32");
  assert.equal(unc.nativeDirectory("//host/share/coworkers/writer"), "\\\\host\\share\\coworkers\\writer");
});

async function mainFixture(t) {
  const mainUrl = new URL("./main.mjs", import.meta.url);
  const source = await readFile(mainUrl, "utf8");
  const declaration = (name) => {
    const found = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m"))?.[0];
    assert.ok(found, `Missing main helper ${name}`);
    return found;
  };
  const timers = new Set();
  const later = (work, ms) => { const timer = setTimeout(work, ms); timers.add(timer); return timer; };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const state = { pid: 1235, alive: true, cleanupPending: true, readFailure: false, preparationFailure: false, cancellation: "confirmed", armFailure: false, commitFailure: false, exitFailure: false, notice: null, workerConfirmed: true, memory: Promise.resolve() };
  const effects = { requests: [], helpers: [], stops: [], exits: 0, commits: 0, backupWrites: 0, resetWrites: 0, ordinary: 0, exitChecks: 0, alerts: [] };
  const coworker = { slug: "writer", path: "/fixture/coworkers/writer", workspaceId: "workspace_fixture", createdAt: "2026-01-01T00:00:00.000Z" };
  const owner = { ...coworker, coworkerCreatedAt: coworker.createdAt, coworkerIdentity: coworkerIdentity(coworker), kind: "private", threadId: "ses_fixture", conversationId: "ses_fixture" };
  const metadata = { owner, workspaceId: coworker.workspaceId, coworkerCreatedAt: coworker.createdAt };
  let currentCoworker = coworker;
  let transportOptions;
  let invoke;
  let beforeQuit;
  const exitTasks = [];
  const frame = { url: "file:///fixture/index.html" };
  const contents = { mainFrame: frame };
  const handle = {
    url: "http://127.0.0.1:1",
    managedOpencodeV2: { get pid() { return state.pid; }, isAlive: () => state.alive },
    stop: async () => { effects.stops.push("engine"); state.alive = false; state.pid = null; },
    nativeCleanupRequest: async (request) => {
      assert.equal(request.workspaceId, coworker.workspaceId);
      assert.equal(request.directory, coworker.path);
      effects.requests.push(request);
      if (state.readFailure) throw new Error("Untrusted diagnostic with private contents must not reach the reset error.");
      const route = request.path.split("?")[0];
      if (route === "/api/session/active") return Response.json({ data: {} });
      if (route === `/api/session/${owner.threadId}`) return Response.json({ data: { id: owner.threadId, projectID: "project_fixture", location: { directory: coworker.path }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1, idle: 1 } } });
      if (route.endsWith("/message")) return Response.json({ data: [], cursor: {} });
      if (route.endsWith("/inbox")) return Response.json({ data: [] });
      if (route.endsWith("/interrupt")) return Response.json({ interrupted: false });
      if (route.endsWith("/wait") || request.method === "DELETE") return new Response(null, { status: 204 });
      assert.fail(`Unexpected cleanup route ${request.method} ${route}`);
    },
  };
  const admission = createMaintenanceAdmission();
  const context = createContext({
    Error, URL, path, fileURLToPath, console: { info() {} }, AbortController,
    AbortSignal: { any: (signals) => AbortSignal.any(signals), timeout: (ms) => { const controller = new AbortController(); later(() => controller.abort(new Error("Fixture deadline")), Math.min(ms, 100)); return controller.signal; } },
    setTimeout: later, clearTimeout, clearInterval, setImmediate: (work) => exitTasks.push(work),
    process: { argv: ["fixture-node", "fixture-main.mjs"] }, userDataDir: "/fixture/electron-userdata", coworkersDir: "/fixture/coworkers",
    serverHandle: handle, ownerToken: "fixture-owner", denSession: null,
    maintenanceAdmission: admission, resetExitReady: false, resetInProgress: false, resetRetryReady: false, resetBlockedReason: "", quitting: false, quitReady: false,
    localResponsibilitiesTimer: null, responsibilityAbort: new AbortController(), queuedLocalRuns: [], liveWorkerTurns: new Map(), localRunAdmission: Promise.resolve(),
    activeLocalRuns: new Set(), startingServer: null, startingToolsServer: null, responsibilityCleanupError: null, nativeProviderGeneration: null, signInAttempts: new Set(),
    getCoworker: async () => currentCoworker, readCoordinator: async () => assert.fail("A private cleanup must not prepare a coordinator"), coworkerIdentity, withAbort,
    createHeadlessThreadClient: createHeadlessThreadClientV2,
    createNativeV2Client: (options) => { transportOptions = options; return createNativeV2Client(options); },
    createMaintenanceSteps: () => { const steps = createMaintenanceSteps(); return { run: (label, work, options) => steps.run(label, work, { ...options, timeoutMs: 30 }) }; },
    createCollaboration: (options) => ({
      stop: async ({ requireConfirmed }) => {
        assert.equal(requireConfirmed, true);
        effects.stops.push("collaboration");
        await assert.rejects(options.clientFor(coworker.slug, metadata), /Fresh start/);
        const client = await options.cleanupClientFor(coworker.slug, metadata);
        await client.getThreadSnapshot(owner.threadId);
        state.cleanupPending = false;
      },
    }),
    events: { stop: async () => { effects.stops.push("events"); } }, groupExecution: { stop: async () => { effects.stops.push("groups"); } },
    progressSummaries: { stop: () => { effects.stops.push("progress"); } }, conversationMemory: { stop: async () => { effects.stops.push("memory"); await state.memory; } },
    voice: { reset: () => {} }, workerControls: { reset: async () => { effects.stops.push("workers"); return state.workerConfirmed; } },
    computerControl: { reset: async () => { effects.stops.push("computer"); return { confirmed: true }; } }, browserControl: { shutdown: async () => { effects.stops.push("browser"); } },
    toolsServer: { stop: async () => { effects.stops.push("tools"); } },
    maintenance: { preview: async () => ({}), restoreDefaults: async () => {}, factoryReset: async () => { effects.resetWrites++; effects.backupWrites++; } },
    maintenanceScope: () => ({ userData: "/fixture/electron-userdata" }), assertResetConfirmation, assertMaintenanceSender, maintenancePreparationFailure,
    captureMaintenanceProcesses: (pids) => [...new Set(pids)].map((pid) => ({ pid, boot: "fixture-boot", started: `fixture-${pid}` })),
    prepareMaintenanceHandoff: async ({ input }) => {
      assertResetConfirmation(input);
      const helper = { ticket: `fixture-${effects.helpers.length}`, pid: 2000 + effects.helpers.length, backupDirectory: "/fixture/recovery", cancellations: 0,
        cancel: async () => { helper.cancellations++; if (state.cancellation === "failed") throw new Error("Cancellation refused"); if (state.cancellation === "pending") await new Promise(() => {}); },
        arm: async () => { if (state.armFailure) throw new Error("Arm acknowledgement was lost"); }, commit: async () => { effects.commits++; if (state.commitFailure) throw new Error("Commit acknowledgement was lost"); },
      };
      effects.helpers.push(helper);
      if (state.preparationFailure) throw Object.assign(new Error("Preparation ended without a cancellation receipt"), { maintenancePreparation: "not-spawned" });
      return helper;
    },
    waitForMaintenanceExit: async (processes) => { effects.exitChecks++; assert.equal(processes.length, 1); assert.equal(processes[0].pid, effects.helpers.at(-1).pid); if (state.exitFailure) throw new Error("Helper exit was not observed"); },
    readMaintenanceStartup: () => state.notice,
    dialog: { showErrorBox: (_title, message) => effects.alerts.push(message) }, mainWindow: { webContents: contents }, rendererUrl: () => frame.url,
    app: { getAppMetrics: () => [{ pid: 1234 }], exit: () => { effects.exits++; }, on: (name, handler) => { assert.equal(name, "before-quit"); beforeQuit = handler; } },
    ipcMain: { handle: (_name, handler) => { invoke = handler; } }, commands: { ordinary: () => { effects.ordinary++; } },
  });
  const collaboration = source.slice(source.indexOf("const collaboration = createCollaboration({"), source.indexOf("const activityInbox ="));
  const reset = source.slice(source.indexOf("const maintenanceSteps ="), source.indexOf("function registerIpc()"));
  const quit = source.slice(source.indexOf('  app.on("before-quit",'), source.lastIndexOf("\n}"));
  runInContext(`${declaration("collaborationCleanupClient")}\n${collaboration}\n${reset}\n${declaration("registerIpc")}\nregisterIpc();\n${quit}`.replaceAll("import.meta.url", JSON.stringify(mainUrl.href)), context);
  return { state, effects, admission, context, coworker, owner, metadata, handle,
    client: () => runInContext("collaborationCleanupClient", context)(coworker.slug, metadata),
    transport: () => transportOptions, replaceCoworker: (value) => { currentCoworker = value; },
    invoke: (command, payload = {}, event = { sender: contents, senderFrame: frame }) => invoke(event, { command, payload }),
    quit: () => { let prevented = false; beforeQuit({ preventDefault() { prevented = true; } }); return prevented; },
    flushExit: () => { for (const work of exitTasks.splice(0)) work(); },
  };
}

async function preparationFixture(t) {
  const source = await readFile(new URL("./maintenance-handoff.mjs", import.meta.url), "utf8");
  const helpers = ["receive", "send"].map((name) => source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}`, "m"))?.[0]).join("\n");
  const implementation = source.slice(source.indexOf("const preparationFailures ="), source.indexOf("/** Invoked only by")).replace(/^export /gm, "");
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const state = { preflightFailure: false, spawnFailure: false, exits: true, notice: null };
  const effects = { spawns: 0, started: 0, cancellations: 0 };
  const context = createContext({
    Error, path, randomBytes, assertResetConfirmation, maintenanceLaunchArguments, PREPARE_TIMEOUT: 40,
    process: { execPath: "/fixture/node", pid: 1234, cwd: () => "/fixture", env: {} },
    setTimeout: (work, ms) => { const timer = setTimeout(work, Math.min(ms, 40)); timers.add(timer); return timer; }, clearTimeout,
    validateMaintenancePaths: async () => { if (state.preflightFailure) throw new Error("Pre-spawn scope validation refused"); return { backupDirectory: "/fixture/recovery" }; },
    readMaintenanceStartup: (_userData, options) => { assert.equal(options.consume, false); return state.notice; },
    spawn: () => {
      effects.spawns++;
      const child = Object.assign(new EventEmitter(), {
        connected: true, pid: state.spawnFailure ? undefined : 2000,
        send(message, callback) {
          if (message.type === "prepare") queueMicrotask(() => {
            if (state.spawnFailure) {
              const error = Object.assign(new Error("Native spawn refused"), { code: "ENOENT", syscall: "spawn /fixture/node" });
              child.connected = false;
              child.emit("error", error);
              callback(error);
            } else {
              effects.started++;
              child.emit("spawn");
              callback(null);
              child.emit("message", { type: "failed", ticket: message.ticket });
            }
          });
          else { assert.equal(message.type, "cancel"); effects.cancellations++; callback(null); }
        },
        disconnect() { child.connected = false; if (state.exits) queueMicrotask(() => child.emit("exit", 0)); },
        unref() {},
      });
      return child;
    },
  });
  const api = runInContext(`${helpers}\n${implementation}\n({ prepareMaintenanceHandoff, maintenancePreparationFailure })`, context);
  return { state, effects, ...api };
}

const assertNoResetWrites = (f) => {
  assert.equal(f.effects.exits, 0);
  assert.equal(f.effects.backupWrites, 0);
  assert.equal(f.effects.resetWrites, 0);
};

test("main cleanup stays identity-scoped behind closed admission without preparing or admitting work", async (t) => {
  const f = await mainFixture(t);
  f.admission.close();
  const client = await f.client();
  assert.equal((await client.getThreadSnapshot(f.owner.threadId)).status.type, "idle");
  assert.equal((await client.abortThread(f.owner.threadId)).accepted, true);
  assert.equal(client.sendTurn, undefined);
  assert.equal(client.nativeSkills.admitInput, undefined);
  assert.equal(client.nativeSkills.listSkills, undefined);
  const before = f.effects.requests.length;
  await assert.rejects(f.transport().fetch(`${f.handle.url}/workspace/${f.coworker.workspaceId}/opencode2/api/session/${f.owner.threadId}/prompt`, { method: "POST" }), /cleanup operations/);
  await assert.rejects(client.getThreadSnapshot("ses_other"), /cleanup operations/);
  f.replaceCoworker({ ...f.coworker, createdAt: "replacement" });
  await assert.rejects(f.client(), /original coworker/);
  f.replaceCoworker(f.coworker);
  f.context.serverHandle = { ...f.handle };
  await assert.rejects(client.getThreadSnapshot(f.owner.threadId), /changed or stopped/);
  f.context.serverHandle = f.handle;
  f.state.alive = false;
  await assert.rejects(f.client(), /changed or stopped/);
  assert.equal(f.effects.requests.length, before);
  assert.equal((await f.invoke("ordinary")).ok, false);
  assert.equal(f.effects.ordinary, 0);
  assertNoResetWrites(f);
});

test("main reset retries safely cancelled cleanup without reopening work or bypassing the renderer handoff", async (t) => {
  const f = await mainFixture(t);
  assert.equal((await f.invoke("maintenance.factoryReset", { confirmation: "delete" })).ok, false);
  assert.equal((await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" }, { sender: { mainFrame: {} }, senderFrame: {} })).ok, false);
  assert.equal(f.effects.helpers.length, 0);
  f.state.readFailure = true;
  const failed = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(failed.ok, false);
  assert.equal(failed.maintenanceRetryable, true);
  assert.match(failed.error, /Collaboration.*safely cancelled/);
  assert.doesNotMatch(failed.error, /private contents/);
  assert.equal(f.state.cleanupPending, true);
  assert.equal(f.effects.helpers[0].cancellations, 1);
  assert.equal(f.effects.exitChecks, 1);
  for (const name of ["workers", "computer", "browser"]) assert.ok(f.effects.stops.includes(name));
  assert.equal((await f.invoke("ordinary")).ok, false);
  assertNoResetWrites(f);
  f.state.readFailure = false;
  const retried = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.result.phase, "handoff");
  assert.equal(f.handle.managedOpencodeV2.pid, null);
  assert.equal(f.handle.managedOpencodeV2.isAlive(), false);
  assert.equal(f.effects.helpers.length, 2);
  assert.equal(f.state.cleanupPending, false);
  assert.equal(f.admission.closed, true);
  assert.equal(f.effects.commits, 0);
  assertNoResetWrites(f);
  assert.equal((await f.invoke("maintenance.handoffReceived", { handoffId: "stale" })).ok, false);
  assert.equal((await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" })).ok, false);
  assert.equal(f.effects.helpers.length, 2);
  f.state.armFailure = true;
  const unarmed = await f.invoke("maintenance.handoffReceived", { handoffId: retried.result.handoffId });
  assert.equal(unarmed.ok, false);
  assert.equal(unarmed.maintenanceRetryable, true);
  assert.equal(f.effects.commits, 0);
  assertNoResetWrites(f);
  f.state.armFailure = false;
  const finalAttempt = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(finalAttempt.ok, true, finalAttempt.error);
  assert.equal(f.effects.helpers.length, 3);
  assert.equal(f.handle.managedOpencodeV2.pid, null);
  assert.equal(f.effects.stops.filter((name) => name === "engine").length, 1);
  assert.equal((await f.invoke("maintenance.handoffReceived", { handoffId: finalAttempt.result.handoffId })).ok, true);
  assert.equal(f.effects.commits, 1);
  assert.equal(f.effects.exits, 0);
  f.flushExit();
  assert.equal(f.effects.exits, 1);
});

test("main reset blocks retry and quit when helper cancellation, exit or commitment is uncertain", async (t) => {
  for (const fault of ["prepare", "failed", "pending", "exit", "commit", "receipt"]) {
    const f = await mainFixture(t);
    f.state.preparationFailure = fault === "prepare";
    f.state.readFailure = fault !== "commit";
    if (["failed", "pending"].includes(fault)) f.state.cancellation = fault;
    if (fault === "exit") f.state.exitFailure = true;
    if (fault === "receipt") f.state.notice = { blocked: true };
    let response = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
    if (fault === "commit") {
      assert.equal(response.ok, true, response.error);
      f.state.commitFailure = true;
      response = await f.invoke("maintenance.handoffReceived", { handoffId: response.result.handoffId });
    }
    assert.equal(response.ok, false);
    assert.equal(response.maintenanceRetryable, false);
    assert.match(response.error, /Keep this app open; retry and quit are blocked/);
    assert.equal((await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" })).ok, false);
    assert.equal(f.effects.helpers.length, 1);
    assert.equal(f.effects.helpers[0].cancellations, fault === "prepare" ? 0 : 1);
    assert.equal((await f.invoke("ordinary")).ok, false);
    assert.equal(f.quit(), true);
    f.flushExit();
    assertNoResetWrites(f);
  }
});

test("main shutdown bounds failed stops, preserves independent cleanup and joins unfinished steps on retry", async (t) => {
  const f = await mainFixture(t);
  const memory = Promise.withResolvers();
  f.state.memory = memory.promise;
  f.state.workerConfirmed = false;
  const failed = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(failed.ok, false);
  assert.equal(failed.maintenanceRetryable, true);
  assert.match(failed.error, /Conversation memory.*in time/);
  for (const name of ["workers", "computer", "browser"]) assert.ok(f.effects.stops.includes(name));
  assert.equal(f.effects.stops.includes("engine"), false);
  assertNoResetWrites(f);
  f.state.workerConfirmed = true;
  memory.resolve();
  const retried = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(f.effects.stops.filter((name) => name === "memory").length, 1);
  assert.equal(f.effects.stops.filter((name) => name === "workers").length, 2);
  assert.equal(f.effects.stops.filter((name) => name === "engine").length, 1);
  assert.equal(f.effects.commits, 0);
  assertNoResetWrites(f);
  const stopping = await mainFixture(t);
  const completedStop = Promise.withResolvers();
  stopping.handle.stop = async () => { stopping.effects.stops.push("engine"); stopping.state.alive = false; stopping.state.pid = null; await completedStop.promise; };
  const timedOut = await stopping.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(timedOut.maintenanceRetryable, true);
  assert.equal(stopping.handle.managedOpencodeV2.pid, null);
  let settled = false;
  const retry = stopping.invoke("maintenance.factoryReset", { confirmation: "DELETE" }).then((response) => { settled = true; return response; });
  await new Promise(setImmediate);
  assert.equal(stopping.effects.helpers.length, 2);
  assert.equal(settled, false, "A null PID cannot substitute for the owned stop promise fulfilling.");
  assert.equal(stopping.effects.stops.filter((name) => name === "engine").length, 1);
  completedStop.resolve();
  assert.equal((await retry).ok, true);
  assertNoResetWrites(stopping);
  const blocked = await mainFixture(t);
  blocked.handle.stop = async () => { blocked.state.alive = false; blocked.state.pid = null; throw new Error("The owned server cached a failed shutdown"); };
  const rejected = await blocked.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
  assert.equal(rejected.maintenanceRetryable, false);
  assert.match(rejected.error, /cannot be retried in this app session/);
  assert.equal((await blocked.invoke("maintenance.factoryReset", { confirmation: "DELETE" })).ok, false);
  assert.equal(blocked.effects.helpers.length, 1);
  assertNoResetWrites(blocked);
});

test("main reset never reuses a confirmed stop receipt for a replacement handle or generation", async (t) => {
  for (const replacement of ["handle", "native", "pid"]) {
    const f = await mainFixture(t);
    const ready = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
    assert.equal(ready.ok, true, ready.error);
    f.state.armFailure = true;
    const cancelled = await f.invoke("maintenance.handoffReceived", { handoffId: ready.result.handoffId });
    assert.equal(cancelled.maintenanceRetryable, true);
    if (replacement === "handle") f.context.serverHandle = { ...f.handle };
    if (replacement === "native") f.handle.managedOpencodeV2 = { get pid() { return null; }, isAlive: () => false };
    if (replacement === "pid") f.state.pid = 9876;
    const refused = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
    assert.equal(refused.ok, false);
    assert.equal(refused.maintenanceRetryable, false);
    assert.equal(f.effects.stops.filter((name) => name === "engine").length, 1);
    assert.equal(f.effects.commits, 0);
    assertNoResetWrites(f);
  }
});

test("main reset recovers preparation only from branded no-helper or exited-helper receipts", async (t) => {
  for (const fault of ["preflight", "spawn", "cancelled", "exit", "receipt"]) {
    const preparation = await preparationFixture(t);
    preparation.state.preflightFailure = fault === "preflight";
    preparation.state.spawnFailure = fault === "spawn";
    preparation.state.exits = fault !== "exit";
    preparation.state.notice = fault === "receipt" ? { blocked: true } : null;
    const f = await mainFixture(t);
    const nextPrepare = f.context.prepareMaintenanceHandoff;
    f.context.prepareMaintenanceHandoff = preparation.prepareMaintenanceHandoff;
    f.context.maintenancePreparationFailure = preparation.maintenancePreparationFailure;
    const failed = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
    const safe = ["preflight", "spawn", "cancelled"].includes(fault);
    assert.equal(failed.ok, false);
    assert.equal(failed.maintenanceRetryable, safe, failed.error);
    assert.equal(f.context.resetInProgress, !safe);
    assert.equal(f.admission.closed, true);
    assert.equal((await f.invoke("ordinary")).ok, false);
    assert.equal(preparation.effects.started, ["preflight", "spawn"].includes(fault) ? 0 : 1);
    assert.equal(preparation.effects.spawns, fault === "preflight" ? 0 : 1);
    assertNoResetWrites(f);
    if (safe) {
      f.context.prepareMaintenanceHandoff = nextPrepare;
      const retried = await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" });
      assert.equal(retried.ok, true, retried.error);
      assert.equal(f.effects.helpers.length, 1);
      assert.equal(f.effects.commits, 0);
      assertNoResetWrites(f);
    } else {
      assert.equal(f.quit(), true);
      assert.equal((await f.invoke("maintenance.factoryReset", { confirmation: "DELETE" })).ok, false);
      assert.equal(preparation.effects.spawns, 1);
    }
  }
});
