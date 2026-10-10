import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import { captureBrowserFilm } from "@openwork/cdp";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";

/**
 * An OpenCode v1 chat history, isolated in its own database file, that the
 * desktop's v1 → v2 upgrade can migrate. The same database is written on every
 * run: fixed ids, fixed timestamps, the real v1.18.30 schema
 * (fixtures/opencode-v1-history/schema.sql) and four made-up chats, one of
 * them a sub-chat, so a parent must be copied before its child.
 *
 * Local only: set OPENWORK_EVAL_V1_HISTORY_SOURCE to a real opencode.db to
 * migrate a copy of its most recent chats instead (OPENWORK_EVAL_V1_HISTORY_LIMIT,
 * default 40). The source is opened read-only and the copy leaves out accounts
 * and credentials. Never commit such a copy, and never run it in CI.
 */

const execFileAsync = promisify(execFile);
const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "opencode-v1-history", "schema.sql");
const BASE_TIME = Date.UTC(2026, 0, 5, 9, 0, 0);
const MODEL = { providerID: "fixture", modelID: "fixture-model" };
const SECRET_TABLES = new Set(["account", "account_state", "control_account", "credential"]);

export interface V1FixtureChat {
  id: string;
  parentId: string | null;
  title: string;
  prompt: string;
  reply: string;
  /** A file the assistant read, as a completed tool step. */
  readFile?: string;
}

function fixtureId(prefix: "ses" | "msg" | "prt", n: number): string {
  // Same shape as engine ids (prefix, 12 hex digits, 14 characters), ascending.
  return `${prefix}_${n.toString(16).padStart(12, "0")}FixtureHistory`;
}

export const V1_FIXTURE_CHATS: readonly V1FixtureChat[] = [
  {
    id: fixtureId("ses", 1), parentId: null, title: "Summarize the quarterly budget",
    prompt: "Summarize budget.md in three bullet points.",
    reply: "Spending is 4% under plan, travel is the largest overrun, and hiring moved to Q3.",
    readFile: "budget.md",
  },
  {
    id: fixtureId("ses", 2), parentId: fixtureId("ses", 1), title: "Find last year's travel total (sub-chat)",
    prompt: "Find last year's travel total.",
    reply: "Last year's travel total was $182,400.",
  },
  {
    id: fixtureId("ses", 3), parentId: null, title: "Draft the launch email",
    prompt: "Draft a short launch email for the new release.",
    reply: "Subject: The new release is here. It is faster, works offline, and keeps your chats safe.",
  },
  {
    id: fixtureId("ses", 4), parentId: null, title: "Clean up the meeting notes",
    prompt: "Turn these meeting notes into action items.",
    reply: "Action items: send the agenda, book the room, and share the budget summary.",
  },
];

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Write the fixture history for `directory` (the workspace the chats belong to). Overwrites `database`. */
export async function writeV1FixtureHistory(database: string, directory: string): Promise<{ chats: number }> {
  await mkdir(dirname(database), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${database}${suffix}`, { force: true });
  const db = new DatabaseSync(database);
  try {
    db.exec(await readFile(SCHEMA, "utf8"));
    db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', ?, ?, '[]')")
      .run(BASE_TIME, BASE_TIME);
    const session = db.prepare(`INSERT INTO session
      (id, project_id, parent_id, slug, directory, title, version, agent, model, time_created, time_updated)
      VALUES (?, 'global', ?, ?, ?, ?, '1.18.30', 'build', ?, ?, ?)`);
    const message = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)");
    const part = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)");
    let messageN = 0;
    let partN = 0;
    V1_FIXTURE_CHATS.forEach((chat, index) => {
      const start = BASE_TIME + index * 3_600_000;
      const end = start + 6_000;
      session.run(chat.id, chat.parentId, `fixture-chat-${index + 1}`, directory, chat.title,
        json({ id: MODEL.modelID, providerID: MODEL.providerID, variant: "default" }), start, end);
      const userId = fixtureId("msg", ++messageN);
      message.run(userId, chat.id, start, start, json({
        role: "user", time: { created: start }, agent: "build", model: MODEL, summary: { diffs: [] },
      }));
      part.run(fixtureId("prt", ++partN), userId, chat.id, start, start, json({ type: "text", text: chat.prompt }));
      const assistantId = fixtureId("msg", ++messageN);
      const tokens = { input: 120, output: 40, reasoning: 0, cache: { read: 0, write: 0 } };
      message.run(assistantId, chat.id, start + 1_000, end, json({
        parentID: userId, role: "assistant", mode: "build", agent: "build",
        path: { cwd: directory, root: directory }, cost: 0, tokens,
        modelID: MODEL.modelID, providerID: MODEL.providerID,
        time: { created: start + 1_000, completed: end }, finish: "stop",
      }));
      part.run(fixtureId("prt", ++partN), assistantId, chat.id, start + 1_000, start + 1_000, json({ type: "step-start" }));
      if (chat.readFile) {
        part.run(fixtureId("prt", ++partN), assistantId, chat.id, start + 2_000, start + 3_000, json({
          type: "tool", tool: "read", callID: `call_fixture_${index + 1}`,
          state: {
            status: "completed", input: { filePath: join(directory, chat.readFile) },
            output: "Plan: $1.20M. Actual: $1.15M. Travel: +18%. Hiring: moved to Q3.",
            metadata: {}, title: chat.readFile, time: { start: start + 2_000, end: start + 3_000 },
          },
        }));
      }
      part.run(fixtureId("prt", ++partN), assistantId, chat.id, start + 4_000, end, json({
        type: "text", text: chat.reply, time: { start: start + 4_000, end },
      }));
      part.run(fixtureId("prt", ++partN), assistantId, chat.id, end, end, json({
        type: "step-finish", reason: "stop", tokens: { total: 160, ...tokens }, cost: 0,
      }));
    });
  } finally {
    db.close();
  }
  return { chats: V1_FIXTURE_CHATS.length };
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function stringColumn(row: unknown, key: string): string {
  const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : undefined;
  return typeof value === "string" ? value : "";
}

/**
 * Copy the `limit` most recent top-level chats (and their sub-chats) of a real
 * v1 database into `database`, structure included. Accounts and credentials
 * are left out; the source is only read.
 */
export async function copyRecentV1History(source: string, database: string, limit: number): Promise<{ chats: number }> {
  await access(source);
  await mkdir(dirname(database), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${database}${suffix}`, { force: true });
  const db = new DatabaseSync(database);
  try {
    // Tables are copied in schema order, not dependency order; node:sqlite enforces foreign keys by default.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`ATTACH DATABASE ${`'file:${source.replaceAll("'", "''")}?mode=ro'`} AS src`);
    const objects = db.prepare("SELECT type, name, sql FROM src.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all();
    const tables = objects.filter((row) => stringColumn(row, "type") === "table");
    for (const table of tables) db.exec(stringColumn(table, "sql"));
    db.exec(`CREATE TEMP TABLE pick AS
      WITH RECURSIVE roots AS (SELECT id FROM src.session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ${Math.max(1, Math.floor(limit))}),
      tree(id) AS (SELECT id FROM roots UNION SELECT s.id FROM src.session s JOIN tree t ON s.parent_id = t.id)
      SELECT id FROM tree`);
    for (const table of tables) {
      const name = stringColumn(table, "name");
      if (SECRET_TABLES.has(name)) continue;
      const columns = db.prepare(`SELECT name FROM pragma_table_info(${`'${name.replaceAll("'", "''")}'`}, 'src')`).all()
        .map((row) => stringColumn(row, "name"));
      const filter = name === "session" || name === "session_v2" ? "id"
        : columns.includes("session_id") ? "session_id"
          : columns.includes("aggregate_id") ? "aggregate_id"
            : null;
      const where = filter ? ` WHERE ${quoteIdent(filter)} IN (SELECT id FROM temp.pick)` : "";
      db.exec(`INSERT OR IGNORE INTO main.${quoteIdent(name)} SELECT * FROM src.${quoteIdent(name)}${where}`);
    }
    // Indexes and triggers last, so triggers do not fire on the copy itself.
    for (const object of objects.filter((row) => stringColumn(row, "type") !== "table")) db.exec(stringColumn(object, "sql"));
    const picked = db.prepare("SELECT count(*) AS n FROM temp.pick").get();
    db.exec("DETACH DATABASE src");
    const count = typeof picked === "object" && picked !== null ? Reflect.get(picked, "n") : 0;
    return { chats: typeof count === "number" ? count : 0 };
  } finally {
    db.close();
  }
}

/**
 * The chats in a v1 database as content: sessions, messages and parts with
 * their stored data, hashed. Equal before and after a migration means v1
 * history was not changed by it.
 */
export function readV1HistoryDigest(database: string): { sessions: number; messages: number; parts: number; sha256: string } {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    // Streamed row by row: a full history is many gigabytes.
    const hash = createHash("sha256");
    const counts = [0, 0, 0];
    const queries = [
      "SELECT id, parent_id, directory, title, time_created FROM session ORDER BY id",
      "SELECT id, session_id, data FROM message ORDER BY id",
      "SELECT id, message_id, session_id, data FROM part ORDER BY id",
    ];
    queries.forEach((query, index) => {
      hash.update(`\u0000table${index}`);
      for (const row of db.prepare(query).iterate()) {
        hash.update(JSON.stringify(row));
        counts[index]!++;
      }
    });
    return { sessions: counts[0]!, messages: counts[1]!, parts: counts[2]!, sha256: hash.digest("hex") };
  } finally {
    db.close();
  }
}

/**
 * Content coverage after a migration: v1 chats that have messages, and how many
 * of them arrived in v2 with none. Chat counts alone hide a conversion that
 * copied sessions but not their messages.
 */
export function readMigrationCoverage(v1Database: string, v2Database: string): { withMessages: number; emptyInV2: number; v2Messages: number } {
  const db = new DatabaseSync(v1Database, { readOnly: true });
  try {
    db.exec(`ATTACH DATABASE 'file:${v2Database.replaceAll("'", "''")}?mode=ro' AS v2`);
    const row = db.prepare(`SELECT
        (SELECT count(*) FROM main.session s WHERE EXISTS (SELECT 1 FROM main.message m WHERE m.session_id = s.id)) AS withMessages,
        (SELECT count(*) FROM main.session s WHERE EXISTS (SELECT 1 FROM main.message m WHERE m.session_id = s.id)
           AND NOT EXISTS (SELECT 1 FROM v2.session_message sm WHERE sm.session_id = s.id)) AS emptyInV2,
        (SELECT count(*) FROM v2.session_message) AS v2Messages`).get();
    const read = (key: string) => {
      const value = typeof row === "object" && row !== null ? Reflect.get(row, key) : 0;
      return typeof value === "number" ? value : 0;
    };
    return { withMessages: read("withMessages"), emptyInV2: read("emptyInV2"), v2Messages: read("v2Messages") };
  } finally {
    db.close();
  }
}

/** The desktop's live v2 chat database inside an Electron profile. */
async function findV2Database(profileDir: string): Promise<string> {
  const entries = await readdir(profileDir, { recursive: true });
  const match = entries.find((entry) => entry.endsWith(join("opencode-v2", "state", "opencode.db")));
  if (!match) throw new Error("The desktop's v2 chat database was not found in its profile");
  return join(profileDir, match);
}

/**
 * The whole v1 database as an APFS copy-on-write clone: instant, and it takes
 * no disk space until one side changes. Fails rather than falling back to a
 * full byte copy, which could fill the disk.
 */
export async function cloneWholeV1History(source: string, database: string): Promise<{ chats: number }> {
  await access(source);
  await mkdir(dirname(database), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${database}${suffix}`, { force: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    try { await access(`${source}${suffix}`); } catch { continue; }
    // `cp -c` uses clonefile(2) and fails instead of copying bytes (libuv's FICLONE_FORCE is not implemented on macOS).
    await execFileAsync("cp", ["-c", `${source}${suffix}`, `${database}${suffix}`]);
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare("SELECT count(*) AS n FROM session").get();
    const count = typeof row === "object" && row !== null ? Reflect.get(row, "n") : 0;
    return { chats: typeof count === "number" ? count : 0 };
  } finally {
    db.close();
  }
}

/**
 * A source-built Electron-main fetch gate: only the first real v2 import of
 * each arranged attempt waits. The engines, snapshots, backups and all status
 * responses remain real; a renderer-only status delay would not prove this.
 * No request headers, chat data or response bodies are retained by the witness.
 */
async function heldHistoryCopy(database: string, attempts: number) {
  const token = randomBytes(24).toString("hex");
  let held: ServerResponse | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = { installed: false, arrived: 0, released: 0, failed: 0, expired: false };
  const release = (outcome: "continue" | "fail") => {
    if (!held) throw new Error("No real history import is held");
    clearTimeout(timer);
    timer = undefined;
    state.released++;
    if (outcome === "fail") state.failed++;
    held.end(outcome);
    held = null;
  };
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "text/plain");
    if (request.url === "/ready") { state.installed = true; response.end("ready"); return; }
    if (request.url !== "/copy") { response.writeHead(404).end(); return; }
    if (held) { response.writeHead(409).end("fail"); return; }
    state.arrived++;
    if (state.arrived > attempts) { response.end("continue"); return; }
    held = response;
    // The native import has a 30-second deadline. Expiry fails the witness,
    // rather than silently completing before the person's acts finish.
    timer = setTimeout(() => { state.expired = true; release("fail"); }, 25_000);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("History-copy witness has no loopback listener");
  const preload = join(dirname(database), "history-copy-main-fetch.cjs");
  // --require applies only to source-built Electron. The guard excludes the
  // pnpm/Vite processes and every child engine sharing this environment.
  await writeFile(preload, `
if (process.versions.electron && process.type === "browser" && process.env.OPENCODE_DB === ${JSON.stringify(database)}) {
  const delegate = globalThis.fetch;
  let heldAttempts = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST" && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        && url.pathname === "/api/session/import" && heldAttempts < ${attempts}) {
      heldAttempts++;
      const control = await delegate(${JSON.stringify(`http://127.0.0.1:${address.port}/copy`)}, {
        headers: { authorization: ${JSON.stringify(`Bearer ${token}`)} }, signal: init?.signal,
      });
      if (!control.ok || await control.text() !== "continue") {
        return new Response(JSON.stringify({ error: "Fixture-held copy interrupted" }), { status: 503, headers: { "content-type": "application/json" } });
      }
    }
    return delegate(input, init);
  };
  void delegate(${JSON.stringify(`http://127.0.0.1:${address.port}/ready`)}, {
    headers: { authorization: ${JSON.stringify(`Bearer ${token}`)} },
  }).then(response => response.text()).catch(() => undefined);
}
`, { mode: 0o600 });
  return {
    preload,
    read: () => ({ ...state, held: held !== null }),
    release,
    async [Symbol.asyncDispose]() {
      if (held) release("fail");
      clearTimeout(timer);
      server.closeAllConnections();
      try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
      finally { await rm(preload, { force: true }); }
    },
  };
}

/**
 * A signed-in desktop still on OpenCode v1, with an isolated v1 history and the
 * organization's `engineV2Upgrade` feature on, so it is offered the upgrade.
 */
export async function engineV1HistoryUpgrade(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the seeded v1 history is a file the local desktop opens directly");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable Den database");
  if (process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("the real held-copy witness requires source-built Electron's main-process preload");
  }
  await using resources = new AsyncDisposableStack();
  const source = process.env.OPENWORK_EVAL_V1_HISTORY_SOURCE?.trim() || null;
  const profileDir = seed.tmpPath("v1-history-profile");
  const workspaceDir = seed.tmpPath("v1-history-workspace");
  await mkdir(workspaceDir, { recursive: true });
  // Engines store the resolved folder (/private/tmp on macOS, not /tmp); chats
  // written under any other spelling would not belong to the workspace.
  const workspacePath = await realpath(workspaceDir);
  const database = join(profileDir, "opencode-v1", "opencode.db");
  const limit = process.env.OPENWORK_EVAL_V1_HISTORY_LIMIT?.trim();
  const whole = source !== null && limit === "all";
  const seeded = !source
    ? await writeV1FixtureHistory(database, workspacePath)
    : whole
      ? await cloneWholeV1History(source, database)
      : await copyRecentV1History(source, database, Number(limit) || 40);
  const before = readV1HistoryDigest(database);

  const den = await seed.den({ org: { name: "Engine upgrade" } });
  await enableOrganizationCapabilities(seed, den.admin, { engineV2Upgrade: true });
  const opencode2 = process.env.OPENWORK_EVAL_OPENCODE2_BIN?.trim();
  const copyGate = resources.use(await heldHistoryCopy(database, source === null ? 2 : 1));
  const nodeOptions = [process.env.NODE_OPTIONS?.trim(), `--require=${JSON.stringify(copyGate.preload)}`].filter(Boolean).join(" ");
  const app = await seed.desktop({
    den, as: "admin", name: "v1-history-upgrade", profileDir, workspacePath,
    env: {
      // One file for the in-process server, the migration and the v1 engine.
      OPENCODE_DB: database,
      NODE_OPTIONS: nodeOptions,
      ...(opencode2 ? { OPENWORK_OPENCODE2_BIN: opencode2 } : {}),
    },
  });
  const workspace = await seed.workspace(app, workspacePath);
  const witnessDeadline = Date.now() + 5_000;
  while (!copyGate.read().installed && Date.now() < witnessDeadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!copyGate.read().installed) throw new Error("Source-built Electron did not install the real main-process copy gate");
  // Optional recording of the whole journey as CDP screencast frames.
  const filmDir = process.env.OPENWORK_EVAL_FILM_DIR?.trim();
  const film = filmDir ? await captureBrowserFilm(app, filmDir) : null;
  resources.defer(async () => { await film?.stop(); });
  const lifetime = resources.move();
  return {
    app, den, workspace, workspacePath, database,
    readHeldCopy: copyGate.read,
    releaseHeldCopy: copyGate.release,
    /** True for the committed fixture; false when a local copy of real history was seeded. */
    fixture: source === null,
    /** The entire real history (an APFS clone), not a recent slice. */
    whole,
    stopFilm: async () => { await film?.stop(); },
    expectedChats: seeded.chats,
    before,
    chats: source === null ? V1_FIXTURE_CHATS : [],
    readV1History: () => readV1HistoryDigest(database),
    readCoverage: async () => readMigrationCoverage(database, await findV2Database(profileDir)),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}
