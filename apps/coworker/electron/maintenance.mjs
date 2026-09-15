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

/** Native beta19086 uses rootDir/opencode.db. Only pass the owned engine's
 * resolved location; never infer it from v1 environment variables or channels. */
export function resolveMaintenanceHistoryDb({ rootDir, databasePath, platform = process.platform } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (rootDir === undefined && databasePath === undefined) throw new Error("Native v2 history is unresolved. Fresh start requires the owned engine rootDir or databasePath.");
  for (const file of [rootDir, databasePath].filter((value) => value !== undefined)) {
    if (typeof file !== "string" || !file || file !== file.trim() || file.includes("\0")
      || !paths.isAbsolute(file) || paths.normalize(file) !== file || file === paths.parse(file).root
      || (platform === "win32" && (!/^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)/.test(file) || /^\\\\[?.]\\/.test(file)))) throw new Error("Fresh start requires unambiguous absolute native v2 filesystem paths.");
  }
  const resolved = rootDir === undefined ? databasePath : paths.join(rootDir, "opencode.db");
  if (paths.basename(resolved) !== "opencode.db" || paths.dirname(resolved) === paths.parse(resolved).root
    || (databasePath !== undefined && databasePath !== resolved)) throw new Error("Native v2 history must be the owned engine rootDir/opencode.db.");
  return resolved;
}

/** Native beta19086 database/path.ts stores Windows absolute paths with '/'. */
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

export function createMaintenanceSteps() {
  const tasks = new Map();
  return {
    async run(label, work, { timeoutMs = 30_000, retry = true } = {}) {
      let task = tasks.get(label);
      if (!task) {
        task = Promise.resolve().then(work);
        tasks.set(label, task);
        void task.catch(() => { if (retry && tasks.get(label) === task) tasks.delete(label); });
      }
      let timer;
      let expired = false;
      try {
        return await Promise.race([task, new Promise((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Error("Shutdown deadline reached.")); }, timeoutMs);
        })]);
      } catch {
        throw Object.assign(new Error(`${label} ${expired ? "did not finish stopping in time" : "could not confirm shutdown"}. No reset was performed.`), { maintenanceRetryable: expired || retry });
      } finally { clearTimeout(timer); }
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
  historyDb = resolveMaintenanceHistoryDb({ databasePath: historyDb });
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
  if (protectedPaths.some((file) => within(historyDb, file) || (!allowedParents.includes(file) && within(file, historyDb)))) throw new Error("Fresh start refuses a protected or legacy history database.");
  if (overlaps(backupDirectory, historyDb)
    || protectedPaths.some((file) => within(backupDirectory, file)
      || (!allowedParents.includes(file) && within(file, backupDirectory)))) throw new Error("Fresh start refuses a shared history or recovery directory.");
  for (const file of [historyDb, `${historyDb}-wal`, `${historyDb}-shm`, `${historyDb}-journal`]) await safePath(file, false);
  await safePath(backupDirectory, true);
  return { entries, backupDirectory, historyDb, coworkers };
}

const sessionTables = ["session_message", "session_pending", "session_inbox", "instruction_entry", "instruction_state"];
const scopedTables = ["session_v2", ...sessionTables, "event_sequence", "event"];
// beta19086 core session/sql.ts, event/sql.ts and database/schema.gen.ts.
// Pin the complete native table shape, not just a few v1-compatible owner columns.
// Legacy/coexisting v1 schemas require separate review, never migration or cleanup here.
const historySchema = {
  session_v2: `id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    workspace_id TEXT, parent_id TEXT, fork_session_id TEXT, fork_boundary TEXT, slug TEXT NOT NULL,
    directory TEXT NOT NULL, path TEXT, title TEXT, version TEXT NOT NULL, share_url TEXT,
    summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, metadata TEXT,
    cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
    tokens_reasoning INTEGER NOT NULL DEFAULT 0, tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
    revert TEXT, permission TEXT, agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_idle INTEGER, time_viewed INTEGER, idle_outcome TEXT, time_compacting INTEGER, time_archived INTEGER, time_suspended INTEGER,
    resume_attempts INTEGER NOT NULL DEFAULT 0`,
  session_message: `id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
    type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL`,
  session_pending: `id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
    type TEXT NOT NULL, data TEXT NOT NULL, delivery TEXT, admitted_seq INTEGER NOT NULL, time_created INTEGER NOT NULL`,
  session_inbox: `id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE,
    type TEXT NOT NULL, payload TEXT NOT NULL, delivery TEXT NOT NULL, enqueued_seq INTEGER NOT NULL, time_created INTEGER NOT NULL`,
  instruction_entry: `session_id TEXT NOT NULL REFERENCES session_v2(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT,
    removed INTEGER NOT NULL DEFAULT false, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY(session_id, key)`,
  instruction_state: `session_id TEXT PRIMARY KEY REFERENCES session_v2(id) ON DELETE CASCADE,
    epoch_start INTEGER NOT NULL, through_seq INTEGER NOT NULL, initial_values TEXT NOT NULL, current_values TEXT NOT NULL`,
  event_sequence: `aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT`,
  event: `id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, created INTEGER NOT NULL DEFAULT 0, type TEXT NOT NULL, data TEXT NOT NULL`,
  instruction_blob: `hash TEXT PRIMARY KEY, value TEXT`,
  kv: `key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL`,
  project: `id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_url_override TEXT, icon_color TEXT,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT`,
  project_directory: `project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE, directory TEXT NOT NULL,
    type TEXT, strategy TEXT, time_created INTEGER NOT NULL, PRIMARY KEY(project_id, directory)`,
  worktree: `project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE, directory TEXT NOT NULL,
    strategy TEXT, time_created INTEGER NOT NULL, PRIMARY KEY(project_id, directory)`,
  workspace: `id TEXT PRIMARY KEY, provider TEXT NOT NULL, binding TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL`,
  permission: `id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    action TEXT NOT NULL, resource TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL`,
  credential: `id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT,
    active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL`,
  account: `id TEXT PRIMARY KEY, email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
    token_expiry INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL`,
  account_state: `id INTEGER PRIMARY KEY, active_account_id TEXT REFERENCES account(id) ON DELETE SET NULL, active_org_id TEXT`,
  control_account: `email TEXT NOT NULL, url TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL,
    token_expiry INTEGER, active INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, PRIMARY KEY(email, url)`,
  migration: `id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL`,
};
const historyIndexes = [
  "CREATE UNIQUE INDEX event_aggregate_seq_idx ON event(aggregate_id, seq)",
  "CREATE INDEX event_aggregate_type_seq_idx ON event(aggregate_id, type, seq)",
  "CREATE UNIQUE INDEX permission_project_action_resource_idx ON permission(project_id, action, resource)",
  "CREATE INDEX session_inbox_session_delivery_seq_idx ON session_inbox(session_id, delivery, enqueued_seq)",
  "CREATE UNIQUE INDEX session_inbox_session_enqueued_seq_idx ON session_inbox(session_id, enqueued_seq)",
  "CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq)",
  "CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq)",
  "CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id, time_created, id)",
  "CREATE INDEX session_message_time_created_idx ON session_message(time_created)",
  "CREATE INDEX session_pending_session_delivery_seq_idx ON session_pending(session_id, delivery, admitted_seq)",
  "CREATE UNIQUE INDEX session_pending_session_compaction_idx ON session_pending(session_id) WHERE session_pending.type = 'compaction'",
  "CREATE UNIQUE INDEX session_pending_session_admitted_seq_idx ON session_pending(session_id, admitted_seq)",
  "CREATE INDEX session_v2_project_idx ON session_v2(project_id)",
  "CREATE INDEX session_v2_workspace_idx ON session_v2(workspace_id)",
  "CREATE INDEX session_v2_parent_idx ON session_v2(parent_id)",
  "CREATE INDEX session_v2_time_suspended_idx ON session_v2(time_suspended) WHERE session_v2.time_suspended IS NOT NULL",
];
let pinnedHistoryShape;

async function openHistory(file, readOnly) {
  if (!await info(file)) return null;
  // Requires the packaged Electron runtime's builtin, not a native addon.
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly, enableForeignKeyConstraints: true, timeout: 1000 });
}

async function inspectHistory(db, root) {
  const shape = (database, name) => JSON.stringify({
    columns: database.prepare(`PRAGMA table_xinfo(${quote(name)})`).all()
      .map(({ cid, type, ...field }) => ({ ...field, type: type.toUpperCase() })).sort((a, b) => a.name.localeCompare(b.name)),
    keys: database.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()
      .map(({ id, ...key }) => JSON.stringify(key)).sort(),
    indexes: database.prepare(`PRAGMA index_list(${quote(name)})`).all().map(({ seq, name, ...index }) => JSON.stringify({
      ...index, name: index.origin === "c" ? name : null,
      columns: database.prepare(`PRAGMA index_xinfo(${quote(name)})`).all().map(({ cid, ...field }) => field),
      where: (database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?").get(name)?.sql?.match(/\bWHERE\s+(.+)/is)?.[1] ?? "")
        .replace(/["`]([a-z_][a-z0-9_]*)["`]/g, "$1").replace(/;\s*$/, "").replace(/\s+/g, " ").trim().replace(/\bis not null\b/gi, "IS NOT NULL"),
    })).sort(),
  });
  if (!pinnedHistoryShape) {
    const { DatabaseSync } = await import("node:sqlite");
    const pinned = new DatabaseSync(":memory:");
    try {
      for (const [name, fields] of Object.entries(historySchema)) pinned.exec(`CREATE TABLE ${quote(name)} (${fields})`);
      for (const sql of historyIndexes) pinned.exec(sql);
      pinnedHistoryShape = new Map(Object.keys(historySchema).map((name) => [name, shape(pinned, name)]));
    } finally { pinned.close(); }
  }
  const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*'").all();
  const columns = new Map(schema.map(({ name, sql }) => {
    if (!pinnedHistoryShape.has(name)) throw new Error(`Unrecognized history table (${name}). Reset refused.`);
    if (!sql || /\bVIRTUAL\s+TABLE\b/i.test(sql)) throw new Error("Unrecognized virtual history table. Reset refused.");
    if (/\b(?:CHECK|COLLATE|DEFERRABLE|STRICT|AUTOINCREMENT)\b|\bWITHOUT\s+ROWID\b/i.test(sql)) throw new Error(`Unrecognized history constraints (${name}). Reset refused.`);
    const fields = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    if (fields.some((col) => col.hidden)) throw new Error("Unrecognized generated history columns. Reset refused.");
    if (shape(db, name) !== pinnedHistoryShape.get(name)) throw new Error(`Unsupported native beta19086 history schema (${name}). Reset refused.`);
    return [name, fields.map((col) => col.name)];
  }));
  for (const name of pinnedHistoryShape.keys()) if (!columns.has(name)) throw new Error(`Missing native beta19086 history table (${name}). Reset refused.`);
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('trigger', 'view') LIMIT 1").get()) throw new Error("History has unrecognized triggers or views. Reset refused.");
  const directoryScope = maintenanceHistoryScope(root);
  const selected = db.prepare("SELECT id, directory FROM session_v2 WHERE directory = ? OR substr(directory, 1, ?) = ?").all(directoryScope.directory, directoryScope.prefix.length, directoryScope.prefix);
  if (selected.some((row) => typeof row.id !== "string" || !row.id)) throw new Error("History contains an invalid session identity. Reset refused.");
  for (const row of db.prepare("SELECT directory FROM session_v2").all()) directoryScope.nativeDirectory(row.directory);
  for (const directory of new Set(selected.map((row) => directoryScope.nativeDirectory(row.directory)))) await safePath(directory, true);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS coworker_reset_scope (id TEXT PRIMARY KEY); DELETE FROM coworker_reset_scope;");
  const select = db.prepare("INSERT INTO coworker_reset_scope VALUES (?)");
  for (const row of selected) select.run(row.id);
  const scope = "SELECT id FROM temp.coworker_reset_scope";
  // These references are not foreign keys in v2; do not strand another directory's child or fork.
  if (db.prepare(`SELECT 1 FROM session_v2 WHERE (parent_id IN (${scope}) OR fork_session_id IN (${scope})) AND id NOT IN (${scope}) LIMIT 1`).get()) throw new Error("A Coworker session has an out-of-scope descendant or fork. Reset refused.");
  const predicates = Object.fromEntries(scopedTables.map((name) => [name, `${quote(name === "session_v2" ? "id" : name.startsWith("event") ? "aggregate_id" : "session_id")} IN (${scope})`]));
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
        const originalPlan = JSON.stringify(plan);
        if (await stop() !== true) throw new Error("Native shutdown was not confirmed. No reset was performed.");
        await admission.drain();
        plan = await paths();
        if (JSON.stringify(plan) !== originalPlan) throw new Error("Native storage paths changed while stopping. Reset refused.");
        await mkdir(plan.backupDirectory, { recursive: true, mode: 0o700 });
        await chmod(plan.backupDirectory, 0o700);
        backupPath = await mkdtemp(path.join(plan.backupDirectory, "fresh-start-"));
        await chmod(backupPath, 0o700);
        await writePrivate(path.join(backupPath, "intent.json"), { version: 1, createdAt: new Date().toISOString(), entries: plan.entries, historyDb: plan.historyDb });
        await onBackup(backupPath);
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
          historySchema: "opencode-native-beta19086", historyTables: scopedTables,
          entries: present.map((entry) => ({ ...entry, backup: `files/${entry.name}`, original: `originals/${entry.name}` })),
          restore: "Close Coworker first. Preserve any new setup; never overwrite it. Restore only scoped native v2 history rows, not the shared database. The history schema and shared project/workspace/instruction_blob rows must still match. Legacy v1 history is not imported or reset. Originals are moved only after this backup completed.",
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
          db.exec("DELETE FROM event_sequence WHERE aggregate_id IN (SELECT id FROM temp.coworker_reset_scope); DELETE FROM session_v2 WHERE id IN (SELECT id FROM temp.coworker_reset_scope);");
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
