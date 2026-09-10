import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readlink, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { trustedComputerSender } from "./computer-control.mjs";

const RESET_CLOSED = "Fresh start is in progress or needs attention. Quit and reopen Open Coworker before doing more work.";
// Conservatively reject case-only aliases on the default macOS/Windows filesystems.
const pathKey = (file) => process.platform === "linux" ? file : file.toLowerCase();
const within = (root, file) => pathKey(file) === pathKey(root) || pathKey(file).startsWith(`${pathKey(root)}${root.endsWith(path.sep) ? "" : path.sep}`);
const overlaps = (a, b) => within(a, b) || within(b, a);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export function assertMaintenanceSender(event, contents, url) {
  if (!trustedComputerSender(event, contents, url)) throw new Error("Fresh start requires the trusted Open Coworker main frame.");
}

export function assertResetConfirmation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.confirmation !== "DELETE" || Object.keys(input).some((key) => key !== "confirmation")) throw new Error("Type DELETE exactly to confirm Fresh start.");
}

/** OpenCode v1.18.18 database/database.ts: relative OPENCODE_DB is relative to
 * Global.Path.data; the pinned release channel uses opencode.db. A custom or
 * PATH binary's compiled channel is unknown, so never guess its history file. */
export function resolveMaintenanceHistoryDb({ env, dataDirectory, bundled, version, platform = process.platform }) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const explicit = env.OPENCODE_DB;
  if (explicit) {
    if (explicit !== explicit.trim() || explicit === ":memory:" || (platform === "win32" && /^[A-Za-z]:[^\\/]/.test(explicit))) throw new Error("Fresh start needs an unambiguous filesystem OPENCODE_DB.");
    return paths.isAbsolute(explicit) ? explicit : paths.join(dataDirectory, explicit);
  }
  if (!bundled || version !== "1.18.18") throw new Error("This engine's history database is unresolved. Set OPENCODE_DB to its actual database and restart before Fresh start.");
  return paths.join(dataDirectory, "opencode.db");
}

/** Engine v1.18.18 database/path.ts stores Windows absolute paths with '/'. */
export function maintenanceHistoryScope(root, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const storage = (value) => platform === "win32" ? value.replaceAll("\\", "/") : value;
  const directory = storage(paths.resolve(root));
  const prefix = `${directory}/`;
  return {
    directory, prefix,
    nativeDirectory(value) {
      if (typeof value !== "string") throw new Error("History contains an invalid directory. Reset refused.");
      if (!value) return null; // The engine retains legacy empty directories.
      const native = platform === "win32" ? value.replaceAll("/", "\\") : value;
      const canonical = storage(paths.resolve(native));
      const key = (text) => platform === "linux" ? text : text.toLowerCase();
      const selected = value === directory || value.startsWith(prefix);
      const alias = key(canonical) === key(directory) || key(canonical).startsWith(key(prefix));
      if ((selected && (canonical !== value || !paths.isAbsolute(native))) || (!selected && alias)) throw new Error("History contains ambiguous Coworker directories. Reset refused.");
      return selected ? native : null;
    },
  };
}

/** Closing admission is synchronous and permanent for this process, including on failure. */
export function createMaintenanceAdmission() {
  let closed = false;
  const pending = new Set();
  return {
    get closed() { return closed; },
    assertOpen() { if (closed) throw new Error(RESET_CLOSED); },
    close() { if (closed) throw new Error(RESET_CLOSED); closed = true; },
    run(work) {
      if (closed) return Promise.reject(new Error(RESET_CLOSED));
      const task = Promise.resolve().then(() => {
        if (closed) throw new Error(RESET_CLOSED);
        return work();
      });
      pending.add(task);
      void task.finally(() => pending.delete(task)).catch(() => {});
      return task;
    },
    async drain(timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (pending.size && Date.now() < deadline) await delay(10);
      if (pending.size) throw new Error("Native work did not finish stopping. No reset was performed.");
    },
  };
}

async function info(file) {
  try { return await lstat(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function safePath(file, directory) {
  if (!path.isAbsolute(file) || path.normalize(file) !== file || file === path.parse(file).root) throw new Error("Fresh start requires absolute, non-root storage paths.");
  for (let part = file; ; part = path.dirname(part)) {
    const entry = await info(part);
    if (entry?.isSymbolicLink()) throw new Error("Fresh start cannot use symlinked storage paths.");
    if (part === file && entry && (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) throw new Error("Fresh start found an unexpected storage type or shared hard link.");
    if (part === path.dirname(part)) break;
  }
}

/** Only native-resolved paths enter here. Overrides must describe a complete isolated setup. */
export async function validateMaintenancePaths({ userData, coworkers, serverConfig, runtimeDb, envStore, settings, historyDb, defaults, protectedPaths, allowedParents = [], isDev }) {
  for (const file of [userData, coworkers, serverConfig, runtimeDb, envStore, settings, historyDb]) {
    if (typeof file !== "string" || !file) throw new Error("Fresh start requires explicit native storage paths.");
  }
  const standard = userData === defaults.userData && coworkers === defaults.coworkers && serverConfig === defaults.serverConfig;
  const isolated = ![userData, coworkers, path.dirname(serverConfig)].some((file) =>
    [defaults.userData, defaults.devUserData, defaults.coworkers, path.dirname(defaults.serverConfig)].some((shared) => overlaps(file, shared)));
  if ((!standard || isDev) && !isolated) throw new Error("Fresh start refuses mixed shared/development storage. Use a fully isolated Coworker profile, homes and server configuration.");
  if (!standard && (!/^(electron-userdata|coworker-profile|com\.differentai\.opencoworker(?:\.dev)?)$/.test(path.basename(userData)) || path.basename(coworkers) !== "coworkers")) throw new Error("Fresh start cannot establish ownership of these overridden profile or coworker directories.");
  if (path.basename(serverConfig) !== "coworker-server.json" || path.basename(settings) !== "coworker-settings.json"
    || !["coworker-runtime.sqlite", ...(isolated ? ["runtime.sqlite"] : [])].includes(path.basename(runtimeDb))
    || path.basename(envStore) !== "coworker-env.json"
    || [runtimeDb, envStore, settings].some((file) => path.dirname(file) !== path.dirname(serverConfig))) throw new Error("Fresh start requires Coworker-owned configuration siblings, not shared runtime or credential stores.");
  const entries = [
    { name: "profile", source: userData, directory: true },
    { name: "coworkers", source: coworkers, directory: true },
    ...[["server-config", serverConfig], ["settings", settings], ["runtime-env", envStore], ["runtime-db", runtimeDb],
      ["runtime-wal", `${runtimeDb}-wal`], ["runtime-shm", `${runtimeDb}-shm`], ["runtime-journal", `${runtimeDb}-journal`]]
      .map(([name, source]) => ({ name, source, directory: false })),
  ];
  const backupDirectory = path.join(path.dirname(userData), `${path.basename(userData)}-recovery`);
  for (const [index, entry] of entries.entries()) {
    if (protectedPaths.some((protectedPath) => within(entry.source, protectedPath)
      || (!allowedParents.includes(protectedPath) && within(protectedPath, entry.source)))
      || entries.slice(index + 1).some((other) => overlaps(entry.source, other.source))
      || overlaps(entry.source, historyDb) || overlaps(entry.source, backupDirectory)) throw new Error("Fresh start refuses overlapping or shared storage paths.");
    await safePath(entry.source, entry.directory);
  }
  if (overlaps(backupDirectory, historyDb)
    || protectedPaths.some((file) => within(backupDirectory, file)
      || (!allowedParents.includes(file) && within(file, backupDirectory)))) throw new Error("Fresh start refuses a shared history or recovery directory.");
  for (const file of [historyDb, `${historyDb}-wal`, `${historyDb}-shm`, `${historyDb}-journal`]) await safePath(file, false);
  await safePath(backupDirectory, true);
  return { entries, backupDirectory, historyDb, coworkers };
}

const sessionTables = ["message", "part", "todo", "session_share", "session_context_epoch", "session_input", "session_message"];
const scopedTables = ["session", ...sessionTables, "event_sequence", "event"];
// Current engine metadata (alpha.21); unknown tables still require review.
const preservedTables = ["__drizzle_migrations", "credential", "account_state", "data_migration", "migration", "control_account", "project", "workspace", "project_directory", "permission", "account"];

async function openHistory(file, readOnly) {
  if (!await info(file)) return null;
  // Requires the packaged Electron runtime's builtin, not a native addon.
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly, enableForeignKeyConstraints: true, timeout: 1000 });
}

async function inspectHistory(db, root) {
  const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all();
  const columns = new Map(schema.map(({ name, sql }) => {
    if (!scopedTables.includes(name) && !preservedTables.includes(name)) throw new Error(`Unrecognized history table (${name}). Reset refused.`);
    if (!sql || /\bVIRTUAL\s+TABLE\b/i.test(sql)) throw new Error("Unrecognized virtual history table. Reset refused.");
    const fields = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    if (fields.some((col) => col.hidden)) throw new Error("Unrecognized generated history columns. Reset refused.");
    return [name, fields.map((col) => col.name)];
  }));
  for (const [table, required] of [["session", ["id", "directory", "parent_id", "project_id"]], ["message", ["id", "session_id"]], ["part", ["id", "session_id", "message_id"]], ...sessionTables.slice(2).map((name) => [name, ["session_id"]]), ["event_sequence", ["aggregate_id"]], ["event", ["aggregate_id"]]]) {
    if (!required.every((column) => columns.get(table)?.includes(column))) throw new Error(`Unsupported history schema (${table}). History has not been reset.`);
  }
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' LIMIT 1").get()) throw new Error("History has unrecognized triggers. Reset refused.");
  for (const { name } of schema) {
    if (!scopedTables.includes(name) && columns.get(name).some((column) => ["session_id", "message_id", "aggregate_id"].includes(column))) throw new Error(`Unrecognized history owner (${name}). Reset refused.`);
    const keys = db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all();
    for (const fk of keys.filter((fk) => scopedTables.includes(fk.table))) {
      const allowed = (sessionTables.includes(name) && fk.table === "session" && fk.from === "session_id" && fk.to === "id")
        || (name === "session" && fk.table === "session" && fk.from === "parent_id" && fk.to === "id")
        || (name === "part" && fk.table === "message" && fk.from === "message_id" && fk.to === "id")
        || (name === "event" && fk.table === "event_sequence" && fk.from === "aggregate_id" && fk.to === "aggregate_id");
      if (!allowed || fk.on_delete !== "CASCADE") throw new Error(`Unrecognized history cascade (${name}). Reset refused.`);
    }
    // Parts cascade through their message in the current engine. The denormalized
    // session_id is checked against that message below, not assumed to be an FK.
    if (sessionTables.includes(name) && name !== "part" && !keys.some((fk) => fk.table === "session" && fk.from === "session_id" && fk.to === "id" && fk.on_delete === "CASCADE")) throw new Error(`Missing session cascade (${name}). Reset refused.`);
    if (name === "part" && !keys.some((fk) => fk.table === "message" && fk.from === "message_id" && fk.to === "id" && fk.on_delete === "CASCADE")) throw new Error("Missing message cascade (part). Reset refused.");
    if (name === "event" && !keys.some((fk) => fk.table === "event_sequence" && fk.from === "aggregate_id" && fk.to === "aggregate_id" && fk.on_delete === "CASCADE")) throw new Error("Missing event cascade. Reset refused.");
  }
  const directoryScope = maintenanceHistoryScope(root);
  const selected = db.prepare("SELECT id, directory FROM session WHERE directory = ? OR substr(directory, 1, ?) = ?").all(directoryScope.directory, directoryScope.prefix.length, directoryScope.prefix);
  for (const row of db.prepare("SELECT directory FROM session").all()) directoryScope.nativeDirectory(row.directory);
  for (const directory of new Set(selected.map((row) => directoryScope.nativeDirectory(row.directory)))) await safePath(directory, true);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS coworker_reset_scope (id TEXT PRIMARY KEY); DELETE FROM coworker_reset_scope;");
  const select = db.prepare("INSERT INTO coworker_reset_scope VALUES (?)");
  for (const row of selected) select.run(row.id);
  const scope = "SELECT id FROM temp.coworker_reset_scope";
  if (db.prepare(`SELECT 1 FROM session WHERE parent_id IN (${scope}) AND id NOT IN (${scope}) LIMIT 1`).get()) throw new Error("A Coworker session has an out-of-scope descendant. Reset refused.");
  if (db.prepare(`SELECT 1 FROM part p LEFT JOIN message m ON m.id = p.message_id WHERE (p.session_id IN (${scope}) OR m.session_id IN (${scope})) AND (m.id IS NULL OR p.session_id IS NOT m.session_id) LIMIT 1`).get()) throw new Error("History part/message ownership does not match. Reset refused.");
  const predicates = Object.fromEntries(scopedTables.map((name) => [name, `${quote(name === "session" ? "id" : name.startsWith("event") ? "aggregate_id" : "session_id")} IN (${scope})`]));
  const counts = Object.fromEntries(schema.map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM ${quote(name)}${predicates[name] ? ` WHERE (${predicates[name]}) IS NOT TRUE` : ""}`).get().n]));
  return { schema, columns, predicates, counts, historyCount: selected.length };
}

async function writePrivate(file, value) {
  const handle = await open(file, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  // Windows does not expose directory fsync. File contents are still synced.
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function backupHistory(db, snapshot, file) {
  const handle = await open(file, "wx", 0o600);
  await handle.close();
  const { DatabaseSync } = await import("node:sqlite");
  const backup = new DatabaseSync(file, { enableForeignKeyConstraints: false });
  try {
    backup.exec("BEGIN");
    for (const table of scopedTables) {
      backup.exec(snapshot.schema.find(({ name }) => name === table).sql);
      const columns = snapshot.columns.get(table);
      const insert = backup.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of db.prepare(`SELECT * FROM ${quote(table)} WHERE ${snapshot.predicates[table]}`).iterate()) insert.run(...columns.map((column) => row[column]));
      if (backup.prepare(`SELECT count(*) AS n FROM ${quote(table)}`).get().n !== db.prepare(`SELECT count(*) AS n FROM ${quote(table)} WHERE ${snapshot.predicates[table]}`).get().n) throw new Error("The recovery history copy is incomplete.");
    }
    backup.exec("COMMIT");
    if (backup.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("The recovery history backup did not verify.");
  } finally { backup.close(); }
  const durable = await open(file, "r+");
  try { await durable.sync(); } finally { await durable.close(); }
}

async function copyPrivate(source, destination) {
  const entry = await lstat(source);
  // Directory moves never follow nested links. A recovery copy must not follow them either.
  if (entry.isSymbolicLink()) {
    await symlink(await readlink(source), destination);
  } else if (entry.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) await copyPrivate(path.join(source, name), path.join(destination, name));
    await syncDirectory(destination);
  } else if (entry.isFile()) {
    if (entry.nlink !== 1) throw Object.assign(new Error("A shared hard link prevents an owned recovery backup."), { code: "SHARED_HARDLINK" });
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await chmod(destination, 0o600);
    const handle = await open(destination, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
  } else throw Object.assign(new Error("An unsupported special file prevents a complete recovery backup."), { code: "SPECIAL_FILE" });
}

const identityOf = (entry) => JSON.stringify([entry.dev, entry.ino, entry.mode, entry.nlink, entry.size, entry.mtimeMs, entry.ctimeMs]);

async function verifyCopy(source, destination, snapshot) {
  const original = await lstat(source);
  snapshot.set(source, identityOf(original));
  const copied = await lstat(destination);
  if (original.isSymbolicLink() && copied.isSymbolicLink()) {
    if (await readlink(source) === await readlink(destination)) return;
  } else if (original.isDirectory() && copied.isDirectory()) {
    const names = (await readdir(source)).sort();
    if (JSON.stringify(names) !== JSON.stringify((await readdir(destination)).sort())) throw new Error("Recovery directory contents changed during backup.");
    for (const name of names) await verifyCopy(path.join(source, name), path.join(destination, name), snapshot);
    return;
  } else if (original.isFile() && copied.isFile() && original.nlink === 1 && copied.nlink === 1) {
    const digest = async (file) => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      return hash.digest("hex");
    };
    if (await digest(source) === await digest(destination)) return;
  }
  throw new Error("The recovery copy did not match the original. No reset was performed.");
}

/** Back up first, move reversibly, then commit the scoped history transaction last. */
export function createMaintenance({ admission, paths, coworkerCount, stop, relaunch, restoreDefaults, onBackup = async () => {}, beforeMutation = async () => {}, move = rename, copy = copyPrivate, openDatabase = openHistory }) {
  return {
    restoreDefaults,
    async preview() {
      const plan = await paths();
      const db = await openDatabase(plan.historyDb, true);
      try {
        return { coworkerCount: await coworkerCount(), historyCount: db ? (await inspectHistory(db, plan.coworkers)).historyCount : 0, backupDirectory: plan.backupDirectory };
      } finally { db?.close(); }
    },
    async factoryReset(input) {
      assertResetConfirmation(input);
      admission.close();
      let backupPath;
      let db;
      let transaction = false;
      let committed = false;
      const moved = [];
      try {
        let plan = await paths();
        // Discover unsupported schemas before stopping anything, without creating an absent DB.
        db = await openDatabase(plan.historyDb, true);
        try { if (db) await inspectHistory(db, plan.coworkers); } finally { db?.close(); db = null; }
        await mkdir(plan.backupDirectory, { recursive: true, mode: 0o700 });
        await chmod(plan.backupDirectory, 0o700);
        backupPath = await mkdtemp(path.join(plan.backupDirectory, "fresh-start-"));
        await chmod(backupPath, 0o700);
        await writePrivate(path.join(backupPath, "intent.json"), { version: 1, createdAt: new Date().toISOString(), entries: plan.entries, historyDb: plan.historyDb });
        await onBackup(backupPath);
        const originalPlan = JSON.stringify(plan);
        if (await stop() !== true) throw new Error("Native shutdown was not confirmed. No reset was performed.");
        await admission.drain();
        plan = await paths();
        if (JSON.stringify(plan) !== originalPlan) throw new Error("Native storage paths changed while stopping. Reset refused.");
        await mkdir(path.join(backupPath, "files"), { mode: 0o700 });
        await mkdir(path.join(backupPath, "originals"), { mode: 0o700 });
        const present = [];
        const fileSnapshot = new Map();
        for (const entry of plan.entries) {
          if (!await info(entry.source)) continue;
          await copy(entry.source, path.join(backupPath, "files", entry.name));
          await verifyCopy(entry.source, path.join(backupPath, "files", entry.name), fileSnapshot);
          present.push(entry);
        }
        // All recursive copy/hash/fsync and the full-tree metadata check happen
        // before the shared DB write lock. Quiescence is a reset prerequisite.
        for (const [file, identity] of fileSnapshot) if (identityOf(await lstat(file)) !== identity) throw new Error("Source files changed during backup. Reset refused.");
        await syncDirectory(path.join(backupPath, "files"));
        await syncDirectory(backupPath);
        await syncDirectory(plan.backupDirectory);
        db = await openDatabase(plan.historyDb, false);
        let snapshot;
        if (db) {
          db.exec("BEGIN IMMEDIATE");
          transaction = true;
          snapshot = await inspectHistory(db, plan.coworkers);
          await backupHistory(db, snapshot, path.join(backupPath, "history.sqlite"));
        }
        await writePrivate(path.join(backupPath, "manifest.json"), {
          version: 1, createdAt: new Date().toISOString(), historyDb: plan.historyDb, historyCount: snapshot?.historyCount ?? 0,
          historyTables: scopedTables, entries: present.map((entry) => ({ ...entry, backup: `files/${entry.name}`, original: `originals/${entry.name}` })),
          restore: "Close Coworker first. Preserve any new setup; never overwrite it. Restore only scoped history rows, not the shared database. The history schema and shared project/workspace rows must still match. Originals are moved only after this backup completed.",
        });
        await syncDirectory(backupPath);
        await beforeMutation();
        for (const entry of present) {
          await safePath(entry.source, entry.directory);
          const identity = await lstat(entry.source);
          if (identityOf(identity) !== fileSnapshot.get(entry.source)) throw new Error("A source path changed before its move. Reset refused.");
          const destination = path.join(backupPath, "originals", entry.name);
          if (await info(destination)) throw new Error("A recovery destination already exists. Nothing will be overwritten.");
          await move(entry.source, destination);
          moved.push({ ...entry, destination, dev: identity.dev, ino: identity.ino });
          await syncDirectory(path.dirname(entry.source));
          await syncDirectory(path.dirname(destination));
        }
        for (const entry of moved) if (await info(entry.source)) throw new Error("An original path was recreated by an unconfirmed writer. Reset refused.");
        if (db) {
          db.exec("DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM temp.coworker_reset_scope); DELETE FROM session WHERE id IN (SELECT id FROM temp.coworker_reset_scope);");
          for (const { name } of snapshot.schema) {
            const count = db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get().n;
            if (count !== snapshot.counts[name]) throw new Error(`History preservation check failed (${name}).`);
          }
          await writePrivate(path.join(backupPath, "ready.json"), { version: 1, status: "files-moved-history-commit-pending" });
          db.exec("COMMIT");
          transaction = false;
        }
        committed = true;
        db?.close(); db = null;
        await relaunch();
        return { backupPath };
      } catch (error) {
        const failures = [];
        if (transaction) { try { db.exec("ROLLBACK"); } catch (rollbackError) { failures.push(rollbackError); } }
        if (!committed) for (const entry of moved.reverse()) {
          try {
            if (await info(entry.source)) throw new Error("An original path was recreated; rollback will not overwrite it.");
            const original = await lstat(entry.destination);
            if (original.dev !== entry.dev || original.ino !== entry.ino) throw new Error("A moved original was replaced; rollback will not restore an unrelated path.");
            await move(entry.destination, entry.source);
            await syncDirectory(path.dirname(entry.source));
          } catch (rollbackError) { failures.push(rollbackError); }
        }
        const state = committed ? "Fresh start completed, but relaunch failed. Quit and reopen the app."
          : failures.length ? "Fresh start stopped; recovery needs attention. New paths were not overwritten."
            : "Fresh start was not completed; local files and history were preserved. Quit and reopen the app before retrying.";
        const failure = new Error(`${state} ${error.message}${backupPath ? ` Recovery backup: ${backupPath}` : ""}`, { cause: error });
        failure.recovery = { backupPath: backupPath ?? null, committed, recoveryRequired: failures.length > 0 };
        throw failure;
      } finally { db?.close(); }
    },
  };
}
