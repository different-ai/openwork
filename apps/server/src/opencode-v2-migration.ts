import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { resolveServerLogFileSink, redactServerLogFileRecord } from "./server-log-file.js";
import { isolatedOpencodeV1Database } from "./managed-opencode.js";
import { importNodeSqlite } from "./runtime-db.js";
import {
  createManagedOpencodeV2Server, type ManagedOpencodeV2Server,
} from "./managed-opencode-v2.js";
import { attachHistory, copyHistoryBatches, externalizeHistory, numberField, openHistoryDatabase, restoreHistoryPayloads } from "./opencode-v2-history-store.js";
import { acquireHistoryCopyLock } from "./opencode-v2-history-lock.js";

export interface EngineV2MigrationStatus {
  state: "idle" | "running" | "completed" | "error";
  /**
   * While running: `starting` until the history snapshot is counted,
   * `converting` while the engine converts it (counts do not move), then
   * `restoring` with message counts, then `copying` as chats are imported.
   */
  phase?: "starting" | "converting" | "restoring" | "copying";
  restored?: number;
  restoreTotal?: number;
  imported: number;
  skipped: number;
  total: number;
  /** ISO time the current migration started. */
  startedAt?: string;
  error?: string;
  /** Copy of the v2 chat database taken before this migration wrote to it. */
  backupPath?: string;
  /** Chats left in v1 because they could not be copied; the other chats are still copied. */
  notCopied?: ChatNotCopied[];
  /** Legacy clients may report earlier reduced copies. New migrations never trim. */
  trimmed?: Array<{ id: string; title: string }>;
  /** This run picks up a migration that OpenWork closed before it finished. */
  resumed?: boolean;
}

export interface ChatNotCopied {
  id: string;
  title: string;
  /** Retired whole-chat transfer outcomes, retained for older clients. */
  reason: "too_large" | "rejected" | "stopped";
}

/** Backups of the v2 chat database kept on disk; older ones are removed. */
const KEPT_V2_BACKUPS = 2;
/** Room left free after a migration so the computer keeps working. */
const FREE_SPACE_MARGIN_BYTES = 1024 ** 3;
async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch { return 0; }
}

/** A SQLite database with its write-ahead log, as it would be snapshotted. */
async function databaseSize(path: string): Promise<number> {
  return (await fileSize(path)) + (await fileSize(`${path}-wal`));
}

export function conversionTimeoutMs(snapshotBytes: number): number {
  return 10 * 60_000 + Math.ceil(snapshotBytes / 1024 ** 3) * 3 * 60_000;
}

function formatGigabytes(bytes: number): string {
  return `${Math.max(0.1, Math.ceil((bytes / 1024 ** 3) * 10) / 10)} GB`;
}

/**
 * Refuse before writing anything when the snapshot and backup would not fit.
 * Hosts without statfs skip the check rather than block the migration.
 */
export async function ensureMigrationDiskSpace(options: { directory: string; neededBytes: number }): Promise<void> {
  let available: number;
  try {
    const fs = await statfs(options.directory);
    available = Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return;
  }
  const needed = options.neededBytes + FREE_SPACE_MARGIN_BYTES;
  if (available >= needed) return;
  throw new Error(
    `Not enough free disk space to upgrade safely. Free up about ${formatGigabytes(needed - available)} and try again. Nothing was changed.`,
  );
}

/**
 * Keep a copy of the v2 chat database before a migration imports into it.
 * v1 history is never written, so this is the only data a migration can change.
 */
export async function backupV2Database(options: { database: string; directory: string; now?: Date }): Promise<string | undefined> {
  try { await access(options.database); } catch { return undefined; }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const destination = join(options.directory, `opencode-v2-${stamp}.db`);
  await snapshotV1Database(options.database, destination);
  const backups = (await readdir(options.directory))
    .filter((name) => /^opencode-v2-.+\.db$/.test(name))
    .sort()
    .reverse();
  for (const old of backups.slice(KEPT_V2_BACKUPS)) {
    await rm(join(options.directory, old), { force: true });
  }
  return destination;
}

export function opencodeV1DatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_DB === ":memory:") throw new Error("In-memory OpenCode history cannot be migrated.");
  if (env.OPENCODE_DB?.trim()) return resolve(env.OPENCODE_DB);
  // Engine v1 moved off a shared database a standalone OpenCode v2 owns.
  const isolated = isolatedOpencodeV1Database();
  if (isolated) return isolated;
  return join(env.XDG_DATA_HOME || join(env.HOME || homedir(), ".local", "share"), "opencode", "opencode.db");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SQLite's snapshot includes the WAL. Never copy a live database file directly. */
export async function snapshotV1Database(source: string, destination: string): Promise<void> {
  if (typeof process.versions.bun === "string") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(source, { readonly: true });
    try { db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
    finally { db.close(); }
  } else {
    // Electron runs the server in-process. Yield between backup batches so a
    // large history does not freeze the desktop main thread.
    const { DatabaseSync, backup } = await importNodeSqlite();
    const db = new DatabaseSync(source, { readOnly: true });
    try { await backup(db, destination); } finally { db.close(); }
  }
  await chmod(destination, 0o600);
}

/** Key OpenCode v2 sets in a database it has already converted (`kv` table). */
const V2_CONVERSION_MARKER = "migration.v1-v2";

/**
 * A v1 database that an OpenCode v2 build once opened directly carries a
 * "conversion completed" marker from that day. The converter then skips its
 * work and exports that stale projection, so every chat added since arrives
 * empty. Clear the marker in the private snapshot (never the original) so the
 * converter rebuilds from the v1 tables, which are the source of truth.
 */
export async function clearStaleConversionMarker(database: string): Promise<boolean> {
  const db = typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database)
    : new (await importNodeSqlite()).DatabaseSync(database);
  try {
    const table: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get();
    if (!isRecord(table)) return false;
    const marker: unknown = db.prepare("SELECT key FROM kv WHERE key = ?").get(V2_CONVERSION_MARKER);
    if (!isRecord(marker)) return false;
    db.prepare("DELETE FROM kv WHERE key = ?").run(V2_CONVERSION_MARKER);
    return true;
  } finally { db.close(); }
}

type MigrationSession = { id: string; title: string; directory: string; parentId: string | null };

export async function readMigrationSessions(database: string): Promise<MigrationSession[]> {
  const db = typeof process.versions.bun === "string"
    ? new (await import("bun:sqlite")).Database(database, { readonly: true })
    : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
  try {
    const rows: unknown[] = db.prepare("SELECT id, title, directory, parent_id FROM session ORDER BY time_created, id").all();
    return rows.map((row) => {
      if (!isRecord(row) || typeof row.id !== "string" || typeof row.directory !== "string"
        || !isAbsolute(row.directory) || (row.parent_id !== null && typeof row.parent_id !== "string")) {
        throw new Error("OpenCode v1 history contains an invalid session. The original database was not changed.");
      }
      return { id: row.id, title: typeof row.title === "string" ? row.title : "", directory: row.directory, parentId: row.parent_id };
    });
  } finally { db.close(); }
}

/**
 * Whether v1 has a chat created at or after `since` (ms): one that no finished
 * migration copied, so v2 cannot open it. A missing or unreadable database has none.
 */
export async function hasV1ChatsSince(database: string, since: number): Promise<boolean> {
  try {
    await access(database);
    const db = typeof process.versions.bun === "string"
      ? new (await import("bun:sqlite")).Database(database, { readonly: true })
      : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
    try {
      return isRecord(db.prepare("SELECT 1 AS found FROM session WHERE time_created >= ? LIMIT 1").get(since));
    } finally { db.close(); }
  } catch {
    return false;
  }
}

/** Whether v1 has the chat `id`. A missing or unreadable database has none. */
export async function hasV1Chat(database: string, id: string): Promise<boolean> {
  try {
    await access(database);
    const db = typeof process.versions.bun === "string"
      ? new (await import("bun:sqlite")).Database(database, { readonly: true })
      : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
    try {
      return isRecord(db.prepare("SELECT 1 AS found FROM session WHERE id = ?").get(id));
    } finally { db.close(); }
  } catch {
    return false;
  }
}

/** The folder v1 recorded for the top-level chat `id`; null when v1 has no such
 * chat, it is delegated, or the database is missing or unreadable. */
export async function v1ChatDirectory(database: string, id: string): Promise<string | null> {
  try {
    await access(database);
    const db = typeof process.versions.bun === "string"
      ? new (await import("bun:sqlite")).Database(database, { readonly: true })
      : new (await importNodeSqlite()).DatabaseSync(database, { readOnly: true });
    try {
      const row: unknown = db.prepare("SELECT directory, parent_id FROM session WHERE id = ?").get(id);
      return isRecord(row) && row.parent_id === null && typeof row.directory === "string" && isAbsolute(row.directory)
        ? row.directory : null;
    } finally { db.close(); }
  } catch {
    return null;
  }
}

export interface MigrationRequest {
  source: string;
  storageDir: string;
  bin: string;
  /** The coordinator has stopped the owning engine before this is opened. */
  targetDatabase: string;
  backup?: { database: string; directory: string };
}

export interface MigrationScratch { directory: string; converterPid?: number }

type Stage = "snapshot" | "externalizing" | "converting" | "restoring" | "copying" | "completed";
interface Checkpoint {
  source: string;
  target: string;
  phase: Stage;
  sourceKey?: string;
  backupPath?: string;
  snapshotStartedAt: number;
}

async function sourceDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function checkpointAt(path: string): Promise<Checkpoint | undefined> {
  let data: unknown;
  try { data = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw new Error("The saved history copy could not be read. Its files were preserved.");
  }
  if (!isRecord(data) || typeof data.source !== "string" || typeof data.target !== "string"
    || !["snapshot", "externalizing", "converting", "restoring", "copying", "completed"].includes(String(data.phase))) {
    throw new Error("The saved history copy is invalid. Its files were preserved.");
  }
  const phase = data.phase;
  if (phase !== "snapshot" && phase !== "externalizing" && phase !== "converting" && phase !== "restoring" && phase !== "copying" && phase !== "completed") throw new Error("Invalid history stage");
  if (typeof data.snapshotStartedAt !== "number") throw new Error("The saved copy has no snapshot time. Its files were preserved.");
  return { source: data.source, target: data.target, phase, snapshotStartedAt: data.snapshotStartedAt,
    ...(typeof data.sourceKey === "string" ? { sourceKey: data.sourceKey } : {}),
    ...(typeof data.backupPath === "string" ? { backupPath: data.backupPath } : {}) };
}

/** Estimate only the stages still ahead. Raw archives and projections can be
 * much smaller than a v1 file's allocated pages; do not charge five fresh copies
 * for a resume that has already snapshotted and converted. Values stay in SQL. */
async function remainingCopyBytes(original: string, converted: string, target: string, restoring: boolean, backup: boolean, sourceKey: string): Promise<number> {
  const db = await openHistoryDatabase(converted);
  try {
    attachHistory(db, original, "original");
    attachHistory(db, target, "destination");
    let archive = 0;
    for (const table of ["message", "part"]) {
      const archived = db.prepare("SELECT 1 FROM destination.sqlite_master WHERE type = 'table' AND name = ?").get(`openwork_v1_${table}`);
      archive += numberField(db.prepare(`SELECT coalesce(sum(length(CAST(s.data AS BLOB))), 0) AS n FROM original.${table} s
        ${archived ? `WHERE NOT EXISTS (SELECT 1 FROM destination.openwork_v1_${table} t WHERE t.source_key = ? AND t.id = s.id AND t.data = s.data)` : ""}`)
        .get(...(archived ? [sourceKey] : [])), "n");
    }
    const projection = numberField(db.prepare(`SELECT coalesce(sum(length(CAST(data AS BLOB))), 0) AS n FROM session_message
      WHERE session_id IN (SELECT DISTINCT s.session_id FROM session_message s
        WHERE NOT EXISTS (SELECT 1 FROM destination.session_message t WHERE t.id = s.id))`).get(), "n");
    const payload = restoring ? numberField(db.prepare("SELECT coalesce(sum(length(CAST(json_quote(value) AS BLOB))), 0) AS n FROM openwork_payload").get(), "n") : 0;
    // Payloads can grow both the staging projection and its target copy. Count
    // all of them conservatively; neither archived raw rows nor a saved backup
    // need to be allocated again on a copying-stage resume.
    return archive + projection + payload * 2 + (backup ? await databaseSize(target) : 0);
  } finally { db.close(); }
}

function historyLog(event: string, attributes: Record<string, string | number | undefined>): void {
  const record = { severityText: "INFO", body: `History copy ${event}`, attributes: { ...attributes, "process.pid": process.pid }, time: new Date().toISOString() };
  const line = JSON.stringify(record);
  // Workers are piped to the supervisor's file sink, not its (possibly /dev/null)
  // inherited stdout. In-process servers use that same sink directly.
  if (!process.send) resolveServerLogFileSink()?.write(line);
  console.log(line);
}

/** The transfer is entirely SQLite-to-SQLite. Large strings never enter a JS
 * chat object; reversible references bound the native converter's payloads.
 * Stage files survive errors and process death, and target batches checkpoint
 * atomically with their writes. The original database is only ever read. */
export async function migrateOpencodeV1History(options: MigrationRequest & {
  progress: (status: EngineV2MigrationStatus) => void;
  scratch?: (scratch: MigrationScratch) => void;
  /** Integration fault boundary, called only after a committed transfer batch. */
  batch?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<void> {
  await mkdir(options.storageDir, { recursive: true, mode: 0o700 });
  const directory = join(options.storageDir, "history-copy");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, "checkpoint.json");
  const original = join(directory, "source.db");
  const convertedDirectory = join(directory, "converted");
  const converted = join(convertedDirectory, "opencode.db");
  const status: EngineV2MigrationStatus = { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0 };
  const report = () => options.progress({ ...status });
  let converter: ManagedOpencodeV2Server | undefined;
  let ownership: Awaited<ReturnType<typeof acquireHistoryCopyLock>> | undefined;
  try {
    options.signal?.throwIfAborted();
    ownership = await acquireHistoryCopyLock(options.targetDatabase);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let saved = await checkpointAt(path);
    if (saved && (saved.source !== resolve(options.source) || saved.target !== resolve(options.targetDatabase))) {
      throw new Error("The saved history copy belongs to another profile. Its files were preserved.");
    }
    if (saved?.phase === "completed") {
      // A previous complete transfer retained a receipt, not unfinished work.
      await rm(directory, { recursive: true });
      await mkdir(directory, { mode: 0o700 });
      saved = undefined;
    }
    const checkpoint: Checkpoint = saved ?? { source: resolve(options.source), target: resolve(options.targetDatabase), phase: "snapshot", snapshotStartedAt: Date.now() };
    status.resumed = saved !== undefined;
    status.startedAt = new Date(checkpoint.snapshotStartedAt).toISOString();
    let stageStarted = Date.now();
    let stageDone = 0;
    let stageTotal = 0;
    let lastLogged = stageStarted;
    const logStage = (event: string) => {
      const seconds = (Date.now() - stageStarted) / 1000;
      historyLog(event, { stage: checkpoint.phase, done: stageDone, total: stageTotal, seconds, perSecond: seconds > 0 ? stageDone / seconds : 0 });
    };
    logStage("stage start");
    const commitStage = async (phase: Stage) => {
      if (phase !== checkpoint.phase) {
        logStage("stage end");
        stageStarted = Date.now(); stageDone = 0; stageTotal = 0;
        checkpoint.phase = phase;
        logStage("stage start");
      }
      checkpoint.phase = phase;
      await writeFile(`${path}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    };
    if (checkpoint.phase === "snapshot") {
      await ensureMigrationDiskSpace({ directory: options.storageDir,
        // Source, reversible conversion workspace, original-row archive and
        // projected payloads can coexist, plus a backup of existing v2 history.
        neededBytes: await databaseSize(options.source) * 5 + await databaseSize(options.targetDatabase),
      });
      await commitStage("snapshot");
      await rm(`${original}.tmp`, { force: true });
      await snapshotV1Database(options.source, `${original}.tmp`);
      await rename(`${original}.tmp`, original);
      checkpoint.sourceKey = await sourceDigest(original);
      await mkdir(convertedDirectory, { recursive: true, mode: 0o700 });
      await rm(converted, { force: true });
      await snapshotV1Database(original, converted);
      await clearStaleConversionMarker(converted);
      await commitStage("externalizing");
    }
    if (!checkpoint.sourceKey) throw new Error("The saved history source is missing its fingerprint.");
    if (saved) {
      await ensureMigrationDiskSpace({ directory: options.storageDir, neededBytes:
        checkpoint.phase === "restoring" || checkpoint.phase === "copying"
          ? await remainingCopyBytes(original, converted, options.targetDatabase, checkpoint.phase === "restoring", Boolean(options.backup && !checkpoint.backupPath), checkpoint.sourceKey)
          : await databaseSize(original) * 4 + await databaseSize(options.targetDatabase) });
    }
    const sessions = await readMigrationSessions(original);
    if (await sourceDigest(original) !== checkpoint.sourceKey) throw new Error("The saved source changed. Its files and v2 history were preserved.");
    status.total = sessions.length;
    stageTotal = sessions.length;
    report();
    if (checkpoint.phase === "externalizing") {
      const db = await openHistoryDatabase(converted);
      try { attachHistory(db, original, "original"); await externalizeHistory(db, options.signal, (done, total) => {
        stageDone = done; stageTotal = total;
        if (Date.now() - lastLogged >= 5000) { logStage("progress"); lastLogged = Date.now(); }
      }); }
      finally { db.close(); }
      await commitStage("converting");
    }
    if (checkpoint.phase === "converting") {
      status.phase = "converting"; report();
      const home = join(directory, "home");
      await mkdir(home, { recursive: true, mode: 0o700 });
      converter = await createManagedOpencodeV2Server({ bin: options.bin, rootDir: convertedDirectory, env: {
        HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "data"),
        XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"),
        XDG_STATE_HOME: join(home, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1",
      } });
      options.scratch?.({ directory, converterPid: converter.childPid });
      const deadline = Date.now() + conversionTimeoutMs(await fileSize(original));
      while (true) {
        options.signal?.throwIfAborted();
        const result = await converter.fetchJson("/api/experimental/migration/v1");
        if (result.status !== 200 || !isRecord(result.json)) throw new Error("Could not verify the history conversion.");
        if (result.json.status === "completed") { stageDone = sessions.length; stageTotal = sessions.length; break; }
        if (result.json.status === "error") throw new Error("The history conversion stopped. Its checkpoint and the original history were preserved.");
        if (Date.now() > deadline) throw new Error("History conversion timed out. Retry to resume.");
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      await converter.close(); converter = undefined;
      options.scratch?.({ directory });
      await commitStage("restoring");
    }
    if (checkpoint.phase === "restoring") {
      status.phase = "restoring"; report();
      const db = await openHistoryDatabase(converted);
      let initialDone: number | undefined;
      try { await restoreHistoryPayloads(db, options.signal, (done, total) => {
        initialDone ??= done;
        status.restored = done; status.restoreTotal = total;
        stageDone = done - initialDone; stageTotal = total - initialDone;
        report();
        if (Date.now() - lastLogged >= 5000) { logStage("progress"); lastLogged = Date.now(); }
      }); } finally { db.close(); }
      await commitStage("copying");
    }
    await ensureMigrationDiskSpace({ directory: options.storageDir,
      neededBytes: await remainingCopyBytes(original, converted, options.targetDatabase, false, Boolean(options.backup && !checkpoint.backupPath), checkpoint.sourceKey) });
    status.phase = "copying"; stageTotal = sessions.length; report();
    if (!checkpoint.sourceKey) throw new Error("The saved history source is missing its fingerprint.");
    if (options.backup && !checkpoint.backupPath) {
      checkpoint.backupPath = await backupV2Database(options.backup);
      await commitStage("copying");
    }
    status.backupPath = checkpoint.backupPath;
    const db = await openHistoryDatabase(options.targetDatabase);
    try {
      attachHistory(db, original, "original"); attachHistory(db, converted, "converted");
      const result = await copyHistoryBatches({ database: db, sourceKey: checkpoint.sourceKey, batch: options.batch, signal: options.signal,
        progress: (_id, outcome) => {
          status[outcome]++; stageDone = status.imported + status.skipped; report();
          if (Date.now() - lastLogged >= 5000) { logStage("progress"); lastLogged = Date.now(); }
        } });
      status.imported = result.imported; status.skipped = result.skipped;
    } finally { db.close(); }
    await commitStage("completed");
    await ownership.complete();
    // Raw original rows are verified in the target before staging is retired.
    await rm(directory, { recursive: true });
    logStage("stage end");
    status.state = "completed"; status.phase = undefined; report();
  } catch (error) {
    status.state = "error"; status.phase = undefined;
    status.error = error instanceof Error ? error.message : "History copy stopped. Retry to resume.";
    historyLog("failed", { imported: status.imported, skipped: status.skipped, restored: status.restored });
    report();
  } finally { try { await converter?.close(); } finally { await ownership?.release(); } }
}

export type MigrationProcessRequest = MigrationRequest;
export type MigrationProcessMessage =
  | { type: "progress"; status: EngineV2MigrationStatus }
  | { type: "scratch"; scratch: MigrationScratch };

export async function runOpencodeV1HistoryMigration(options: MigrationRequest & {
  progress: (status: EngineV2MigrationStatus) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (typeof process.versions.electron !== "string") return migrateOpencodeV1History(options);
  const { progress, signal, ...request } = options;
  signal?.throwIfAborted();
  let last: EngineV2MigrationStatus = { state: "running", phase: "starting", imported: 0, skipped: 0, total: 0 };
  let converterPid: number | undefined;
  const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "opencode-v2-migration-process.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json", windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on("line", line => {
      const record = redactServerLogFileRecord({ body: line, attributes: { "process.pid": child.pid } }, []);
      const sink = resolveServerLogFileSink();
      if (sink) sink.write(JSON.stringify(record)); else console.log(JSON.stringify(record));
    });
  }
  child.on("message", (message: unknown) => {
    if (!isRecord(message)) return;
    if (message.type === "scratch" && isRecord(message.scratch)) {
      converterPid = typeof message.scratch.converterPid === "number" ? message.scratch.converterPid : undefined;
    }
    if (message.type === "progress" && isRecord(message.status)) {
      // Messages originate in our own worker; use a typed channel below.
      receiveProgress(message.status);
    }
  });
  function receiveProgress(value: Record<string, unknown>) {
    if (value.state !== "idle" && value.state !== "running" && value.state !== "completed" && value.state !== "error") return;
    if (typeof value.imported !== "number" || typeof value.skipped !== "number" || typeof value.total !== "number") return;
    last = { state: value.state, imported: value.imported, skipped: value.skipped, total: value.total,
      ...(value.phase === "starting" || value.phase === "converting" || value.phase === "restoring" || value.phase === "copying" ? { phase: value.phase } : {}),
      ...(typeof value.restored === "number" ? { restored: value.restored } : {}),
      ...(typeof value.restoreTotal === "number" ? { restoreTotal: value.restoreTotal } : {}),
      ...(typeof value.startedAt === "string" ? { startedAt: value.startedAt } : {}),
      ...(typeof value.backupPath === "string" ? { backupPath: value.backupPath } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}), ...(value.resumed === true ? { resumed: true } : {}) };
    progress(last);
  }
  const ended = new Promise<void>(resolve => {
    child.on("error", () => resolve()); child.once("close", () => resolve());
  });
  const stop = () => { child.kill("SIGTERM"); };
  signal?.addEventListener("abort", stop, { once: true });
  child.send(request);
  await ended;
  signal?.removeEventListener("abort", stop);
  if (converterPid) { try { process.kill(converterPid); } catch { /* already closed */ } }
  if (last.state !== "completed" && last.state !== "error") progress({ ...last, state: "error", phase: undefined,
    error: "Chat migration stopped. Restart OpenWork or retry to resume the saved copy; nothing was trimmed." });
}
