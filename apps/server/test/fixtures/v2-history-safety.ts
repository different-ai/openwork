// Disposable profiles for the v2 history copy safety tests. Nothing here reads
// or writes a real OpenWork profile: every path lives under a fresh temp dir.
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openHistoryDatabase, type HistoryDatabase } from "../../src/opencode-v2-history-store.js";
import type { ServerConfig } from "../../src/types.js";

export const id = (prefix: string, n: number) => `${prefix}_${n.toString().padStart(26, "0")}`;

/** The projected tables the transfer checks, identical in target and conversion. */
export function createV2Schema(db: HistoryDatabase): void {
  db.exec(`CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, worktree TEXT);
    CREATE TABLE IF NOT EXISTS session_v2 (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, time_created INTEGER);
    CREATE TABLE IF NOT EXISTS session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_sequence (aggregate_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, owner_id TEXT);`);
}

/** An existing v2 history: chats a person made on OpenCode v2. */
export async function writeV2History(database: string, chats: Array<{ id: string; title: string; messages: number }>): Promise<void> {
  const db = await openHistoryDatabase(database);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    createV2Schema(db);
    for (const chat of chats) {
      db.prepare("INSERT INTO session_v2 (id, project_id, title, time_created) VALUES (?, 'global', ?, 1)").run(chat.id, chat.title);
      for (let n = 1; n <= chat.messages; n++) {
        db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', ?, ?, ?, ?)")
          .run(`${chat.id}-m${n}`, chat.id, n, n, n, JSON.stringify({ text: `v2 message ${n} of ${chat.title}` }));
      }
      db.prepare("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, NULL)").run(chat.id, chat.messages);
    }
  } finally { db.close(); }
}

/** A minimal OpenCode v1 database with the columns the copy reads. */
export async function writeV1History(database: string, directory: string, chats: Array<{ id: string; title: string; messages: number; created?: number }>): Promise<void> {
  const db = await openHistoryDatabase(database);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
    for (const chat of chats) {
      db.prepare("INSERT INTO session VALUES (?, ?, ?, NULL, ?, ?)").run(chat.id, chat.title, directory, chat.created ?? 1, chat.created ?? 1);
      for (let n = 1; n <= chat.messages; n++) {
        const message = `${chat.id}-m${n}`;
        db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(message, chat.id, n, n, JSON.stringify({ role: "user" }));
        db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)").run(`${message}-p`, message, chat.id, n, n, JSON.stringify({ type: "text", text: `v1 message ${n}` }));
      }
    }
  } finally { db.close(); }
}

export async function digest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * A saved copy that already finished its conversion stages: the snapshot and
 * its projection are on disk and the checkpoint is at `copying`. The transfer
 * then runs without a native converter, exactly as a resumed copy does.
 */
export async function stageConvertedCopy(options: { storageDir: string; source: string; target: string;
  chats: Array<{ id: string; title: string; messages: number }>; backupPath?: string }): Promise<void> {
  const directory = join(options.storageDir, "history-copy");
  await mkdir(join(directory, "converted"), { recursive: true, mode: 0o700 });
  const original = join(directory, "source.db");
  await writeFile(original, await readFile(options.source));
  const converted = await openHistoryDatabase(join(directory, "converted", "opencode.db"));
  try {
    createV2Schema(converted);
    converted.prepare("INSERT INTO project (id, worktree) VALUES ('global', '/')").run();
    for (const chat of options.chats) {
      converted.prepare("INSERT INTO session_v2 (id, project_id, title, time_created) VALUES (?, 'global', ?, 1)").run(chat.id, chat.title);
      for (let n = 1; n <= chat.messages; n++) {
        converted.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', ?, ?, ?, ?)")
          .run(`${chat.id}-m${n}`, chat.id, n, n, n, JSON.stringify({ text: `copied message ${n}` }));
      }
      converted.prepare("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, NULL)").run(chat.id, chat.messages);
    }
  } finally { converted.close(); }
  await writeFile(join(directory, "checkpoint.json"), JSON.stringify({ source: resolve(options.source), target: resolve(options.target),
    phase: "copying", sourceKey: await digest(original), snapshotStartedAt: 1_000,
    ...(options.backupPath ? { backupPath: options.backupPath } : {}) }), { mode: 0o600 });
}

/**
 * A stand-in OpenCode v2 executable: it announces a listener, answers health
 * with its own pid, reports itself idle and lists the chats in OPENCODE_DB, so
 * tests can prove which history the engine actually opened.
 */
export async function writeFakeEngine(directory: string): Promise<string> {
  const path = join(directory, "bin", "opencode2");
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(path, `#!${process.execPath}
import { Database } from "bun:sqlite";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/info") return Response.json({ version: "2.0.26", pid: process.pid });
  if (path === "/api/session/active") return Response.json({ data: {} });
  if (path === "/api/session") {
    const db = new Database(process.env.OPENCODE_DB, { readonly: true });
    try { return Response.json({ data: db.prepare("SELECT id, title FROM session_v2 ORDER BY id").all() }); }
    finally { db.close(); }
  }
  if (path === "/api/model" || path === "/api/provider" || path === "/api/mcp" || path === "/api/skill") return Response.json({ data: [] });
  return new Response(null, { status: 404 });
}});
console.log("server listening on http://127.0.0.1:" + server.port);
`);
  await chmod(path, 0o755);
  return path;
}

/** A process whose command line is an opencode \`serve\`, for lease identity checks. */
export function spawnServeProcess(bin: string): ChildProcess {
  return spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { stdio: "ignore", env: { ...process.env, OPENCODE_DB: join(tmpdir(), "not-used.db") } });
}

/** A pid that certainly belonged to a process that has exited. */
export async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const pid = child.pid;
  await new Promise<void>(done => child.once("exit", () => done()));
  if (pid === undefined) throw new Error("Could not spawn a short-lived process");
  return pid;
}

export function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(done => setTimeout(done, 20));
  }
}

/** A throwaway profile: runtime state, v1 history, HOME and the engine all under one temp dir. */
export async function disposableProfile(run: (profile: { directory: string; config: ServerConfig; engine: string;
  root: string; target: string; storageDir: string; v1: string; statePath: string }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "openwork-v2-history-safety-"));
  const engine = await writeFakeEngine(directory);
  const overrides: Record<string, string> = {
    HOME: directory, USERPROFILE: directory, XDG_DATA_HOME: join(directory, "data"), XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENWORK_RUNTIME_DB: join(directory, "runtime.sqlite"), OPENCODE_DB: join(directory, "v1.db"), OPENWORK_OPENCODE2_BIN: engine,
  };
  const previous = new Map([...Object.keys(overrides), "OPENWORK_ENGINE_V2_PREVIEW"].map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [directory], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const storageDir = join(directory, "opencode-v2");
  const root = join(storageDir, "state");
  await mkdir(root, { recursive: true });
  try {
    await run({ directory, config, engine, root, target: join(root, "opencode.db"), storageDir, v1: join(directory, "v1.db"),
      statePath: join(directory, "engine-v2-preview.json") });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
