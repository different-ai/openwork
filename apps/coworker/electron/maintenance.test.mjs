import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, link, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { assertMaintenanceSender, createMaintenance, createMaintenanceAdmission, maintenanceHistoryScope, resolveMaintenanceHistoryDb, validateMaintenancePaths } from "./maintenance.mjs";
import { normalizeSettings, readSettings, updateSettings } from "./settings.mjs";
import { captureMaintenanceProcesses, maintenanceProcessIdentity, maintenanceLaunchArguments, prepareMaintenanceHandoff, readMaintenanceStartup, waitForMaintenanceExit as waitForCapturedExit } from "./maintenance-handoff.mjs";

const waitForMaintenanceExit = (pids, timeout) => waitForCapturedExit(captureMaintenanceProcesses(pids), timeout);

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "coworker-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolated = path.join(root, "isolated");
  await mkdir(isolated);
  const config = {
    userData: path.join(isolated, "electron-userdata"), coworkers: path.join(isolated, "coworkers"),
    serverConfig: path.join(isolated, "coworker-server.json"), settings: path.join(isolated, "coworker-settings.json"),
    runtimeDb: path.join(isolated, "runtime.sqlite"), envStore: path.join(isolated, "coworker-env.json"), historyDb: path.join(isolated, "opencode.db"),
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
  const db = new DatabaseSync(config.historyDb);
  db.exec(`
    CREATE TABLE project(id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE project_directory(project_id TEXT, directory TEXT);
    CREATE TABLE workspace(id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE account(id TEXT PRIMARY KEY, credential TEXT);
    CREATE TABLE permission(id TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT NOT NULL, parent_id TEXT, project_id TEXT REFERENCES project(id));
    CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, data BLOB);
    CREATE TABLE event_sequence(aggregate_id TEXT PRIMARY KEY, value INTEGER);
    CREATE TABLE event(id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE, data TEXT);
    INSERT INTO project VALUES ('project', 'sentinel');
    INSERT INTO workspace VALUES ('workspace', 'sentinel');
    INSERT INTO account VALUES ('account', 'fixture-credential');
    INSERT INTO permission VALUES ('permission', 'sentinel');
  `);
  for (const name of ["credential", "account_state", "data_migration", "migration", "control_account"]) {
    db.exec(`CREATE TABLE ${name}(id TEXT PRIMARY KEY, value TEXT); INSERT INTO ${name} VALUES ('foreign', 'preserved-${name}');`);
  }
  for (const table of ["todo", "session_share", "session_context_epoch", "session_input", "session_message"]) db.exec(`CREATE TABLE ${table}(session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, value TEXT)`);
  for (const [id, directory] of [["owned", path.join(config.coworkers, "writer")], ["neighbor", `${config.coworkers}-other/writer`], ["unrelated", path.join(root, "another-project")]]) {
    db.prepare("INSERT INTO session VALUES (?, ?, NULL, 'project')").run(id, directory);
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(`msg-${id}`, id, `message-${id}`);
    db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(`part-${id}`, id, `msg-${id}`, new Uint8Array([1, 2, 3]));
    db.prepare("INSERT INTO event_sequence VALUES (?, 1)").run(id);
    db.prepare("INSERT INTO event VALUES (?, ?, ?)").run(`event-${id}`, id, `event-${id}`);
    for (const table of ["todo", "session_share", "session_context_epoch", "session_input", "session_message"]) db.prepare(`INSERT INTO ${table} VALUES (?, 'fixture')`).run(id);
  }
  db.close();
  const admission = createMaintenanceAdmission();
  let relaunched = false;
  const service = createMaintenance({ admission, paths: () => validateMaintenancePaths(config), coworkerCount: async () => 1,
    stop: async () => true, relaunch: async () => { relaunched = true; },
    restoreDefaults: () => updateSettings(config.settings, normalizeSettings({})), ...overrides });
  return { root, config, admission, service, relaunched: () => relaunched };
}

test("reset backs up and removes only Coworker files, sessions and event aggregates, then relaunches", async (t) => {
  const f = await fixture(t);
  const seed = new DatabaseSync(f.config.historyDb);
  seed.prepare("INSERT INTO session VALUES ('owned-child', ?, 'owned', 'project')").run(path.join(f.config.coworkers, "writer"));
  seed.close();
  assert.deepEqual(await f.service.preview(), { coworkerCount: 1, historyCount: 2, backupDirectory: `${f.config.userData}-recovery` });
  const { backupPath } = await f.service.factoryReset({ confirmation: "DELETE" });
  assert.equal(f.relaunched(), true);
  await assert.rejects(stat(f.config.userData), { code: "ENOENT" });
  await assert.rejects(stat(f.config.coworkers), { code: "ENOENT" });
  await assert.rejects(stat(`${f.config.runtimeDb}-wal`), { code: "ENOENT" });
  assert.equal(await readFile(path.join(backupPath, "files", "coworkers", "writer", "memory.md"), "utf8"), "kept in recovery");
  assert.equal(await readFile(path.join(backupPath, "originals", "profile", "onboarding.json"), "utf8"), "old-onboarding");
  assert.equal(await readFile(path.join(f.root, "credentials.json"), "utf8"), "fixture-credential");
  assert.equal((await stat(backupPath)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(backupPath, "history.sqlite"))).mode & 0o777, 0o600);
  const db = new DatabaseSync(f.config.historyDb);
  const backup = new DatabaseSync(path.join(backupPath, "history.sqlite"));
  try {
    assert.deepEqual(db.prepare("SELECT id FROM session ORDER BY id").all().map((row) => row.id), ["neighbor", "unrelated"]);
    assert.deepEqual(db.prepare("SELECT aggregate_id FROM event ORDER BY aggregate_id").all().map((row) => row.aggregate_id), ["neighbor", "unrelated"]);
    assert.equal(db.prepare("SELECT credential FROM account").get().credential, "fixture-credential");
    assert.equal(db.prepare("SELECT value FROM project").get().value, "sentinel");
    assert.equal(db.prepare("SELECT value FROM permission").get().value, "sentinel");
    assert.equal(db.prepare("SELECT value FROM workspace").get().value, "sentinel");
    for (const name of ["credential", "account_state", "data_migration", "migration", "control_account"]) {
      assert.equal(db.prepare(`SELECT value FROM ${name}`).get().value, `preserved-${name}`);
      assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = ?").get(name).n, 0);
    }
    assert.deepEqual(backup.prepare("SELECT id FROM session ORDER BY id").all().map((row) => row.id), ["owned", "owned-child"]);
    for (const table of ["message", "part", "todo", "session_share", "session_context_epoch", "session_input", "session_message"]) assert.deepEqual(db.prepare(`SELECT session_id FROM ${table} ORDER BY session_id`).all().map((row) => row.session_id), ["neighbor", "unrelated"]);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM part").get().n, 1);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM event").get().n, 1);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'account'").get().n, 0);
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
    assert.equal(await readFile(path.join(f.config.userData, "onboarding.json"), "utf8"), "old-onboarding");
    const db = new DatabaseSync(f.config.historyDb);
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3); } finally { db.close(); }
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
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3); } finally { db.close(); }
    assert.equal(f.relaunched(), false);
  }
});

test("ambiguous paths, outside descendants, ownership mismatches and schema drift fail closed", async (t) => {
  const f = await fixture(t);
  for (const patch of [{ userData: f.root }, { coworkers: f.config.userData }, { runtimeDb: path.join(f.root, "shared", "runtime.sqlite") }, { historyDb: path.join(f.config.userData, "opencode.db") }]) await assert.rejects(validateMaintenancePaths({ ...f.config, ...patch }));
  const link = path.join(f.root, "linked");
  await symlink(f.config.historyDb, link);
  await assert.rejects(validateMaintenancePaths({ ...f.config, historyDb: link }), /symlink/);
  for (const sql of [
    "UPDATE session SET parent_id = 'owned' WHERE id = 'unrelated'",
    "UPDATE part SET message_id = 'msg-owned' WHERE id = 'part-unrelated'",
    "CREATE TABLE new_history(session_id TEXT REFERENCES session(id) ON DELETE CASCADE)",
  ]) {
    const db = new DatabaseSync(f.config.historyDb);
    db.exec(sql); db.close();
    await assert.rejects(f.service.preview(), /Reset refused/);
    const repair = new DatabaseSync(f.config.historyDb);
    repair.exec("UPDATE session SET parent_id = NULL; UPDATE part SET message_id = 'msg-unrelated' WHERE id = 'part-unrelated'; DROP TABLE IF EXISTS new_history");
    repair.close();
  }
});

test("unknown schemas fail reset before shutdown, backup, or deletion", async (t) => {
  for (const sql of [
    "CREATE TABLE unknown_records(id TEXT)",
    "CREATE TABLE sqliteXforeign(session_id TEXT REFERENCES session(id) ON DELETE CASCADE)",
    "DROP TABLE session_input",
    "CREATE TRIGGER leak AFTER DELETE ON session BEGIN DELETE FROM account; END",
    "UPDATE session SET parent_id = 'owned' WHERE id = 'unrelated'",
    "UPDATE part SET message_id = 'msg-unrelated' WHERE id = 'part-owned'",
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
      assert.equal(check.prepare("SELECT count(*) AS n FROM session").get().n, 3);
      assert.equal(check.prepare("SELECT credential FROM account").get().credential, "fixture-credential");
    } finally { check.close(); }
  }
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
    assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM event").get().n, 3);
    assert.equal(db.prepare("SELECT count(*) AS n FROM part").get().n, 3);
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
  await assert.rejects(validateMaintenancePaths({ ...f.config, historyDb: path.join(`${f.config.userData}-recovery`, "history.db") }), /recovery directory/);
  await link(path.join(f.root, "credentials.json"), path.join(f.config.userData, "credential-link"));
  await assert.rejects(f.service.factoryReset({ confirmation: "DELETE" }), /shared hard link/);
  assert.equal(await readFile(path.join(f.root, "credentials.json"), "utf8"), "fixture-credential");
  const other = await fixture(t);
  const linked = path.join(other.config.coworkers, "linked");
  await symlink(other.root, linked);
  const db = new DatabaseSync(other.config.historyDb);
  db.prepare("UPDATE session SET directory = ? WHERE id = 'owned'").run(linked); db.close();
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
    assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3);
    assert.equal(db.prepare("SELECT credential FROM account").get().credential, "fixture-credential");
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
      try { assert.equal(before.prepare("SELECT count(*) AS n FROM session").get().n, 3); } finally { before.close(); }
      await writeFile(path.join(f.root, "release-writer"), "release only this fixture");
      await eventually(async () => { try { await stat(path.join(f.root, "relaunched.json")); return true; } catch { return false; } });
      const launched = JSON.parse(await readFile(path.join(f.root, "relaunched.json"), "utf8"));
      assert.equal(launched.notice.blocked, false);
      assert.equal(launched.notice.phase, failBackup ? "failed" : "completed");
      assert.equal(launched.marker, "fixture-env-preserved");
      assert.equal(launched.runAsNode, null);
      assert.equal(launched.args.some((arg) => /discard|stale/.test(arg)), false);
      assert.equal(readMaintenanceStartup(f.config.userData), null, "The notice is consumed once, not replayed on every start.");
      const db = new DatabaseSync(f.config.historyDb);
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, failBackup ? 3 : 2);
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
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3); } finally { db.close(); }
    await writeFile(path.join(f.root, "release-writer"), "release");
    await waitForMaintenanceExit([prepared.helperPid, prepared.writerPid], 5000);
    assert.deepEqual(readMaintenanceStartup(f.config.userData, { consume: false }), { blocked: false, phase: "failed", backupPath: null });
    assert.deepEqual(readMaintenanceStartup(f.config.userData), { blocked: false, phase: "failed", backupPath: null });
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
        assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3);
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

test("engine database selection refuses unresolved channels and respects explicit native paths", () => {
  const input = { env: {}, dataDirectory: "/isolated/opencode", bundled: true, version: "1.18.18" };
  assert.equal(resolveMaintenanceHistoryDb(input), "/isolated/opencode/opencode.db");
  assert.throws(() => resolveMaintenanceHistoryDb({ ...input, bundled: false }), /unresolved/);
  assert.throws(() => resolveMaintenanceHistoryDb({ ...input, version: "1.18.18-custom" }), /unresolved/);
  assert.equal(resolveMaintenanceHistoryDb({ ...input, bundled: false, env: { OPENCODE_DB: "opencode-feature.db" } }), "/isolated/opencode/opencode-feature.db");
  assert.equal(resolveMaintenanceHistoryDb({ ...input, bundled: false, env: { OPENCODE_DB: "/other/owned.db" } }), "/other/owned.db");
  assert.throws(() => resolveMaintenanceHistoryDb({ ...input, env: { OPENCODE_DB: ":memory:" } }), /filesystem/);
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
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM session").get().n, 3); } finally { db.close(); }
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
