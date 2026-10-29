import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { proxyOpencodeV2Request } from "../src/server.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

type NativeSession = { id: string; title: string; location: { directory: string } };
type Engine = { url: string; messageReads: string[]; maxConcurrentMessageReads: number; stop: () => void };

// A stand-in v2 engine: an opaque-cursor session list over every folder, plus
// per-session history. `undecodable` answers 500 like 2.0.26 on old 1.18 rows.
function startEngine(sessions: NativeSession[], options: { undecodable?: Set<string>; historyDelayMs?: number } = {}): Engine {
  const messageReads: string[] = [];
  let concurrent = 0;
  const state = { maxConcurrentMessageReads: 0 };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/session") {
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const offset = Number(url.searchParams.get("cursor")?.split(":")[1] ?? "0");
      const data = sessions.slice(offset, offset + limit);
      const next = offset + data.length < sessions.length ? `opaque:${offset + data.length}` : null;
      return Response.json({ data, cursor: { next } });
    }
    const history = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (history?.[1]) {
      const id = decodeURIComponent(history[1]);
      messageReads.push(id);
      concurrent++;
      state.maxConcurrentMessageReads = Math.max(state.maxConcurrentMessageReads, concurrent);
      try {
        if (options.historyDelayMs) await Bun.sleep(options.historyDelayMs);
        if (options.undecodable?.has(id)) return Response.json({ message: "failed to decode session message" }, { status: 500 });
        return Response.json({ data: [{ id: "msg_1", type: "user", text: "hello" }], cursor: { next: null } });
      } finally { concurrent--; }
    }
    return new Response(null, { status: 404 });
  } });
  return {
    url: `http://127.0.0.1:${server.port}`,
    messageReads,
    get maxConcurrentMessageReads() { return state.maxConcurrentMessageReads; },
    stop: () => server.stop(true),
  };
}

async function profile(run: (paths: { root: string; v1: string; a: string; b: string; config: ServerConfig }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "openwork-v2-session-list-"));
  const previous = { runtime: process.env.OPENWORK_RUNTIME_DB, v1: process.env.OPENCODE_DB };
  const v1 = join(root, "opencode-v1.db");
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.OPENCODE_DB = v1;
  const a = join(root, "workspace-a");
  const b = join(root, "workspace-b");
  await mkdir(a);
  await mkdir(b);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  try { await run({ root, v1, a, b, config }); }
  finally {
    if (previous.runtime === undefined) delete process.env.OPENWORK_RUNTIME_DB; else process.env.OPENWORK_RUNTIME_DB = previous.runtime;
    if (previous.v1 === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = previous.v1;
    await rm(root, { recursive: true, force: true });
  }
}

function writeV1History(database: string, sessions: NativeSession[]) {
  const db = new Database(database, { create: true });
  try {
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT NOT NULL, parent_id TEXT, time_created INTEGER)");
    const insert = db.prepare("INSERT INTO session (id, title, directory, parent_id, time_created) VALUES (?, ?, ?, NULL, ?)");
    sessions.forEach((session, index) => insert.run(session.id, session.title, session.location.directory, index));
  } finally { db.close(); }
}

function workspace(id: string, path: string): WorkspaceInfo {
  return { id, name: id, path, preset: "starter", workspaceType: "local" };
}

/** Pages the workspace list the way the app does: until the native cursor ends. */
async function listWorkspace(config: ServerConfig, engine: Engine, target: WorkspaceInfo, warnings: string[] = []) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 20; pages++) {
    const url = new URL(`http://openwork.test/workspace/${target.id}/opencode2/api/session`);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await proxyOpencodeV2Request({
      actor: { type: "host" }, config, request: new Request(url), url, workspace: target,
      proxyPath: "/opencode2/api/session", connection: { url: engine.url, username: "opencode", password: "test" },
      logWarning: (message, attributes) => warnings.push(`${message}: ${attributes.sessionId}`),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const payload: { data: Array<{ id: string }>; cursor: { next: string | null } } = await response.json();
    ids.push(...payload.data.map(session => session.id));
    cursor = payload.cursor.next;
    if (!cursor) return ids;
  }
  assert.fail("The session list cursor never ended");
}

const session = (id: string, directory: string): NativeSession => ({ id, title: id, location: { directory } });

test("one unreadable chat is left out instead of emptying every workspace list", async () => {
  await profile(async ({ config, a, b }) => {
    const sessions = [
      session("ses_a_healthy", a),
      session("ses_a_undecodable", a),
      session("ses_b_healthy", b),
    ];
    const engine = startEngine(sessions, { undecodable: new Set(["ses_a_undecodable"]) });
    try {
      const warnings: string[] = [];
      assert.deepEqual(await listWorkspace(config, engine, workspace("ws_a", a), warnings), ["ses_a_healthy"]);
      assert.deepEqual(await listWorkspace(config, engine, workspace("ws_b", b)), ["ses_b_healthy"]);
      assert.deepEqual(warnings, ["Left an unreadable chat out of the v2 session list: ses_a_undecodable"]);
    } finally { engine.stop(); }
  });
});

test("hundreds of chats copied from v1 list in every workspace across pages without reading their history", async () => {
  await profile(async ({ config, v1, a, b }) => {
    // Older workspace history sits behind the newest pages of the whole engine.
    const migrated = Array.from({ length: 752 }, (_, index) => session(`ses_v1_${String(index).padStart(4, "0")}`, index < 600 ? b : a));
    writeV1History(v1, migrated);
    const createdOnV2 = session("ses_v2_new", a);
    const engine = startEngine([...migrated, createdOnV2]);
    try {
      const started = Date.now();
      const listedA = await listWorkspace(config, engine, workspace("ws_a", a));
      assert.deepEqual(listedA, [...migrated.slice(600).map(item => item.id), createdOnV2.id]);
      assert.equal((await listWorkspace(config, engine, workspace("ws_b", b))).length, 600);
      // Only the chat v1 never had needs its history read, and only once.
      assert.deepEqual(engine.messageReads, [createdOnV2.id]);
      assert.ok(Date.now() - started < 10_000, "well inside the app's 10 s request limit");
    } finally { engine.stop(); }
  });
});

test("chats that need their history read are read a few at a time", async () => {
  await profile(async ({ config, a }) => {
    const sessions = Array.from({ length: 40 }, (_, index) => session(`ses_v2_${index}`, a));
    const engine = startEngine(sessions, { historyDelayMs: 20 });
    try {
      assert.equal((await listWorkspace(config, engine, workspace("ws_a", a))).length, 40);
      assert.equal(engine.messageReads.length, 40);
      assert.ok(engine.maxConcurrentMessageReads <= 4, `read ${engine.maxConcurrentMessageReads} histories at once`);
      // Homes are remembered: the next poll reads no history at all.
      await listWorkspace(config, engine, workspace("ws_a", a));
      assert.equal(engine.messageReads.length, 40);
    } finally { engine.stop(); }
  });
});
