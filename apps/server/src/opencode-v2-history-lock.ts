import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { openHistoryDatabase, type HistoryDatabase } from "./opencode-v2-history-store.js";

const PENDING = "history-copy.pending";
const LEASE = "engine-lease-";
const MUTEX = "history-copy-mutex.db";
/** `ps` reports start times to the second; allow for that and a slow spawn. */
const START_TIME_TOLERANCE_MS = 3_000;

export type HistoryCopyErrorCode =
  /** Another process holds the history copy lock right now. */
  | "history_copy_active"
  /** An engine owned by a running OpenWork has this history open. */
  | "history_engine_active"
  /** A process holds an engine lease and could not be identified safely. */
  | "history_engine_unverified"
  /** A copy stopped after writing some chats and must resume or roll back first. */
  | "history_copy_interrupted";

/**
 * A chat history copy could not start, or v2 cannot open its history yet.
 * These are never binary problems: callers must not suggest a different engine executable.
 */
export class HistoryCopyError extends Error {
  readonly code: HistoryCopyErrorCode;
  constructor(code: HistoryCopyErrorCode, message: string) {
    super(message);
    this.name = "HistoryCopyError";
    this.code = code;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}

function alive(pid: unknown): pid is number {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ProcessIdentity { startedAt: number; command: string }

/** Parse `ps -o lstart=` ("Tue Oct  7 13:18:52 2026") as printed with TZ=UTC0 and the C locale. */
export function parseProcessStart(value: string): number | undefined {
  const match = value.trim().match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/);
  const month = match ? MONTHS.indexOf(match[1] ?? "") : -1;
  if (!match || month < 0) return undefined;
  const time = Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]));
  return Number.isFinite(time) ? time : undefined;
}

/**
 * What is running as `pid`: null when nothing is, undefined when that cannot be
 * determined (no `ps`, Windows, or a permission error). Unknown is never treated
 * as safe to remove or terminate.
 */
export async function inspectProcess(pid: number): Promise<ProcessIdentity | null | undefined> {
  if (!alive(pid)) return null;
  if (process.platform === "win32") return undefined;
  const output = await new Promise<string | undefined>((resolve) => {
    execFile("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)],
      // UTC and the C locale make the start time unambiguous, whatever this process's zone.
      { env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" }, timeout: 5_000 },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
  if (output === undefined) return alive(pid) ? undefined : null;
  const line = output.trim();
  const match = line.match(/^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
  const startedAt = match ? parseProcessStart(match[1] ?? "") : undefined;
  if (!match || startedAt === undefined) return alive(pid) ? undefined : null;
  return { startedAt, command: match[2] ?? "" };
}

interface LeaseRecord {
  path: string;
  pid?: number;
  child?: number;
  bin?: string;
  /** When the child pid was recorded: right after spawn. */
  recordedAt: number;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function readLease(path: string): Promise<LeaseRecord | undefined> {
  let text: string;
  let modified: number;
  try { [text, modified] = await Promise.all([readFile(path, "utf8"), stat(path).then(info => info.mtimeMs)]); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new HistoryCopyError("history_engine_unverified", "An engine ownership record is unreadable; its history was preserved."); }
  if (typeof data !== "object" || data === null) {
    throw new HistoryCopyError("history_engine_unverified", "An engine ownership record is unreadable; its history was preserved.");
  }
  const recordedAt = "recordedAt" in data && typeof data.recordedAt === "number" && Number.isFinite(data.recordedAt) ? data.recordedAt : modified;
  return {
    path, recordedAt,
    ...("pid" in data && positiveInteger(data.pid) ? { pid: positiveInteger(data.pid) } : {}),
    ...("child" in data && positiveInteger(data.child) ? { child: positiveInteger(data.child) } : {}),
    ...("bin" in data && typeof data.bin === "string" && data.bin ? { bin: data.bin } : {}),
  };
}

type Ownership = "running" | "gone" | "unknown";

/**
 * Whether the OpenWork process that wrote a lease still runs. A pid now used
 * by a process that started after the lease was written is a reused pid.
 */
async function ownerState(lease: LeaseRecord): Promise<Ownership> {
  if (lease.pid === undefined) return "gone";
  if (lease.pid === process.pid) return "running";
  const owner = await inspectProcess(lease.pid);
  if (owner === null) return "gone";
  if (owner === undefined) return "unknown";
  return owner.startedAt > lease.recordedAt + START_TIME_TOLERANCE_MS ? "gone" : "running";
}

type ChildState = "none" | "engine" | "other" | "unknown";

/** Positively identify the lease's engine: an opencode `serve` that started before its lease was written. */
async function childState(lease: LeaseRecord): Promise<ChildState> {
  if (lease.child === undefined) return "none";
  const child = await inspectProcess(lease.child);
  if (child === null) return "none";
  if (child === undefined) return "unknown";
  if (child.startedAt > lease.recordedAt + START_TIME_TOLERANCE_MS) return "other";
  const serving = /(?:^|\s)serve(?:\s|$)/.test(child.command);
  const binary = lease.bin ? child.command.includes(lease.bin) : /opencode/i.test(child.command);
  return serving && binary ? "engine" : "other";
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

/** Stop an engine whose OpenWork exited, re-identifying it before each signal. */
async function stopOrphanEngine(lease: LeaseRecord): Promise<boolean> {
  const pid = lease.child;
  if (pid === undefined) return true;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const state = await childState(lease);
    if (state === "none" || state === "other") return true;
    if (state !== "engine") return false;
    try { process.kill(pid, signal); } catch { return !alive(pid); }
    if (await waitForExit(pid, signal === "SIGTERM" ? 5_000 : 2_000)) return true;
  }
  return !alive(pid);
}

/** SQLite's OS lock is released even on SIGKILL. Avoid PID lock-file stealing,
 * which races two processes trying to recover the same abandoned owner. */
async function exclusive(root: string): Promise<HistoryDatabase> {
  const db = await openHistoryDatabase(join(root, MUTEX));
  try {
    db.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE");
    return db;
  } catch {
    db.close();
    throw new HistoryCopyError("history_copy_active", "Another OpenWork window is copying chat history into OpenCode v2. Wait for it to finish.");
  }
}

/** Engine starts hold the mutex for a moment; only a copy or recovery holds it for long. */
async function exclusiveWithin(root: string, ms: number): Promise<HistoryDatabase> {
  const deadline = Date.now() + ms;
  while (true) {
    try { return await exclusive(root); }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

interface PendingFence { token?: string; pid?: number; createdAt?: number }

/** Older builds wrote a plain-text fence with no owner; it parses as an empty owner. */
async function readFence(root: string): Promise<PendingFence | undefined> {
  let text: string;
  try { text = await readFile(join(root, PENDING), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null) return {};
    return {
      ...("token" in data && typeof data.token === "string" ? { token: data.token } : {}),
      ...("pid" in data && positiveInteger(data.pid) ? { pid: positiveInteger(data.pid) } : {}),
      ...("createdAt" in data && typeof data.createdAt === "number" ? { createdAt: data.createdAt } : {}),
    };
  } catch { return {}; }
}

/**
 * Partially copied chats are the only state a fence protects: each copied chat
 * is created with its checkpoint in one transaction and marked complete only
 * after it was verified. Without unfinished checkpoints the target is consistent.
 */
export async function historyCopyTargetConsistent(database: string): Promise<boolean> {
  if (!await exists(database)) return true;
  const db = await openHistoryDatabase(database);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const table: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'openwork_history_copy'").get();
    if (typeof table !== "object" || table === null) return true;
    const partial: unknown = db.prepare("SELECT 1 AS found FROM openwork_history_copy WHERE completed = 0 LIMIT 1").get();
    return typeof partial !== "object" || partial === null;
  } finally { db.close(); }
}

/**
 * Remove every chat a copy created but never finished (rows it owns through
 * its checkpoint), returning the target to a consistent state. Existing v2
 * chats and fully copied chats are never touched; originals stay in v1.
 */
export function rollbackPartialHistoryCopy(db: HistoryDatabase): number {
  db.exec("PRAGMA busy_timeout = 5000");
  const table: unknown = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'openwork_history_copy'").get();
  if (typeof table !== "object" || table === null) return 0;
  const partial = db.prepare("SELECT source_key, session_id FROM openwork_history_copy WHERE completed = 0").all();
  if (!partial.length) return 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of partial) {
      if (typeof row !== "object" || row === null || !("source_key" in row) || !("session_id" in row)
        || typeof row.source_key !== "string" || typeof row.session_id !== "string") throw new Error("An unfinished history checkpoint is unreadable.");
      db.prepare("DELETE FROM session_message WHERE session_id = ?").run(row.session_id);
      db.prepare("DELETE FROM session_v2 WHERE id = ?").run(row.session_id);
      db.prepare("DELETE FROM openwork_history_copy WHERE source_key = ? AND session_id = ?").run(row.source_key, row.session_id);
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return partial.length;
}

export interface HistoryCopyLock {
  /** Publish the fence immediately before the first write to the target. */
  beginTransfer(): Promise<void>;
  /** Whether this lock published the fence. */
  readonly fenced: boolean;
  /** The target is consistent again: lift the fence this lock published. */
  complete(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Exclusive ownership of a v2 history database for a copy or recovery.
 *
 * Everything that can refuse runs before any durable state is written: the OS
 * mutex, then every engine lease. Live engines owned by a running OpenWork
 * (including another app sharing this history) refuse the copy; nothing is
 * marked. Engines left behind by an OpenWork that exited are stopped only
 * when `stopOrphanEngines` is set and the process is positively identified as
 * that lease's opencode `serve`. A reused pid is never signalled.
 *
 * The pending fence is published only by `beginTransfer`, right before the
 * target is written, and carries this lock's owner token.
 */
export async function acquireHistoryCopyLock(database: string, options: { stopOrphanEngines?: boolean } = {}): Promise<HistoryCopyLock> {
  const root = dirname(database);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const mutex = await exclusive(root);
  const token = randomBytes(16).toString("hex");
  let fenced = false;
  let released = false;
  try {
    for (const name of await readdir(root)) {
      if (!name.startsWith(LEASE)) continue;
      const lease = await readLease(join(root, name));
      if (!lease) continue;
      const [owner, child] = await Promise.all([ownerState(lease), childState(lease)]);
      // A running OpenWork owns this engine (it may be starting, serving, or
      // shared by another installed app). It is never stopped from here.
      if (owner === "running") {
        throw new HistoryCopyError("history_engine_active", "Another OpenCode v2 engine is using this history (open in another OpenWork window). Close it before copying earlier chats.");
      }
      if (owner === "unknown" || child === "unknown") {
        throw new HistoryCopyError("history_engine_unverified", "An OpenCode v2 process could not be identified. Restart your computer before copying earlier chats.");
      }
      if (child === "engine") {
        if (!options.stopOrphanEngines) {
          throw new HistoryCopyError("history_engine_active", "Another OpenCode v2 engine, left by an earlier OpenWork, still has this history open.");
        }
        if (!await stopOrphanEngine(lease)) {
          throw new HistoryCopyError("history_engine_unverified", "An OpenCode v2 engine left by an earlier OpenWork did not stop. Restart your computer before copying earlier chats.");
        }
      }
      // Neither its OpenWork nor its engine runs (or the pid now belongs to an unrelated process).
      await rm(lease.path, { force: true });
    }
  } catch (error) { mutex.close(); throw error; }
  return {
    get fenced() { return fenced; },
    async beginTransfer() {
      if (released) throw new Error("This history copy lock was released.");
      if (fenced) return;
      const path = join(root, PENDING);
      const temporary = `${path}.${token}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 2, token, pid: process.pid, createdAt: Date.now(),
        note: "History copy must finish before the engine opens this database." })}\n`, { mode: 0o600 });
      await rename(temporary, path);
      fenced = true;
    },
    async complete() {
      if (released) throw new Error("This history copy lock was released.");
      // Under the mutex, a fence is ours or abandoned by a process that died
      // holding it; either way this owner has made the target consistent.
      const current = await readFence(root);
      if (current && current.token !== undefined && current.token !== token && fenced) {
        throw new Error("The history copy fence changed owner; it was preserved.");
      }
      await rm(join(root, PENDING), { force: true });
      fenced = false;
    },
    async release() {
      if (released) return;
      released = true;
      mutex.close();
    },
  };
}

export interface EngineHistoryLease {
  child(pid: number | undefined): Promise<void>;
  release(): Promise<void>;
}

/**
 * Register an engine on a v2 history database. A copy that is running holds
 * the mutex and keeps the database closed. A fence left by a copy that is no
 * longer running is lifted when the target holds no partially copied chat, so
 * an interrupted optional copy never locks a person out of their v2 history;
 * otherwise the caller resumes or rolls back that copy first.
 */
export async function acquireEngineHistoryLease(root: string, options: { bin?: string } = {}): Promise<EngineHistoryLease> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const path = join(root, `${LEASE}${process.pid}-${randomBytes(12).toString("hex")}.json`);
  const mutex = await exclusiveWithin(root, 2_000).catch(() => {
    throw new HistoryCopyError("history_copy_active", "Chat history is being copied into OpenCode v2. Your chats open when it finishes.");
  });
  try {
    if (await readFence(root)) {
      if (!await historyCopyTargetConsistent(join(root, "opencode.db"))) {
        throw new HistoryCopyError("history_copy_interrupted", "History migration is incomplete: an earlier copy stopped partway. OpenWork resumes or undoes it before opening OpenCode v2.");
      }
      // The copy that published this fence is gone and left nothing half-copied.
      await rm(join(root, PENDING), { force: true });
    }
    await writeFile(path, JSON.stringify({ pid: process.pid, recordedAt: Date.now(), ...(options.bin ? { bin: options.bin } : {}) }), { flag: "wx", mode: 0o600 });
  } finally { mutex.close(); }
  return {
    async child(pid: number | undefined) {
      await writeFile(path, JSON.stringify({ pid: process.pid, child: pid, recordedAt: Date.now(), ...(options.bin ? { bin: options.bin } : {}) }), { mode: 0o600 });
    },
    async release() { await rm(path, { force: true }); },
  };
}

/** Whether a copy fence exists for this history (for status and recovery). */
export async function historyCopyFenced(database: string): Promise<boolean> {
  return (await readFence(dirname(database))) !== undefined;
}
