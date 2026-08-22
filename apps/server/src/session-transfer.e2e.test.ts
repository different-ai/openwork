import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const envKeys: Array<{ key: string; value: string | undefined }> = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
  while (envKeys.length) {
    const entry = envKeys.pop()!;
    if (entry.value === undefined) delete process.env[entry.key];
    else process.env[entry.key] = entry.value;
  }
});

function setEnv(key: string, value: string) {
  envKeys.push({ key, value: process.env[key] });
  process.env[key] = value;
}

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-transfer-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  roots.push(root);
  // Keep import provenance in a throwaway database instead of the developer's
  // real ~/.config/openwork/runtime.sqlite.
  setEnv("OPENWORK_RUNTIME_DB", join(root, "runtime.sqlite"));
  return root;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** An OpenCode stand-in with two sessions: one plain, one carrying a token. */
function startMockOpencode(input?: { sessionDirectory?: string }) {
  const createdSessionIds: string[] = [];
  const promptedSessionIds: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const directory = input?.sessionDirectory ?? request.headers.get("x-opencode-directory");
      const session = (id: string, title: string) => ({
        id,
        title,
        slug: title.toLowerCase().replace(/\s+/g, "-"),
        directory,
        time: { created: 100, updated: 200 },
      });

      if (url.pathname === "/session") {
        if (request.method === "POST") {
          const body: unknown = await request.json();
          const title =
            typeof body === "object" && body !== null && typeof Reflect.get(body, "title") === "string"
              ? String(Reflect.get(body, "title"))
              : "New session";
          const id = `ses_created_${createdSessionIds.length + 1}`;
          createdSessionIds.push(id);
          return Response.json(session(id, title));
        }
        return Response.json([session("ses_1", "Hostname Check"), session("ses_2", "Deploy notes")]);
      }

      if (url.pathname === "/session/status") {
        return Response.json({ ses_1: { type: "idle" }, ses_2: { type: "idle" } });
      }

      if (url.pathname === "/session/ses_1") return Response.json(session("ses_1", "Hostname Check"));
      if (url.pathname === "/session/ses_2") return Response.json(session("ses_2", "Deploy notes"));

      const createdMatch = url.pathname.match(/^\/session\/(ses_created_\d+)$/);
      if (createdMatch?.[1] && (request.method === "GET" || request.method === "DELETE")) {
        return Response.json(
          request.method === "DELETE" ? { ok: true } : session(createdMatch[1], "Imported session"),
        );
      }

      if (url.pathname === "/session/ses_1/message") {
        return Response.json([
          {
            info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 150 } },
            parts: [{ id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "What host am I on?" }],
          },
          {
            info: { id: "msg_2", sessionID: "ses_1", role: "assistant", time: { created: 200 } },
            parts: [{ id: "prt_2", messageID: "msg_2", sessionID: "ses_1", type: "text", text: "hostname: mock-host" }],
          },
        ]);
      }

      if (url.pathname === "/session/ses_2/message") {
        return Response.json([
          {
            info: { id: "msg_3", sessionID: "ses_2", role: "assistant", time: { created: 200 } },
            parts: [
              {
                id: "prt_3",
                messageID: "msg_3",
                sessionID: "ses_2",
                type: "text",
                text: `run: export GITHUB_TOKEN=${SECRET}`,
              },
            ],
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/todo") {
        return Response.json([{ content: "Validate exports", status: "completed", priority: "high" }]);
      }
      if (url.pathname === "/session/ses_2/todo") return Response.json([]);

      if (/^\/session\/[^/]+\/prompt$/.test(url.pathname) && request.method === "POST") {
        promptedSessionIds.push(url.pathname.split("/")[2] ?? "");
        return Response.json({ ok: true });
      }
      if (/^\/session\/[^/]+$/.test(url.pathname) && request.method === "PATCH") {
        return Response.json(session(url.pathname.split("/")[2] ?? "", "Renamed"));
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, createdSessionIds, promptedSessionIds };
}

async function startOpenworkServer(input: {
  workspaceRoot: string;
  opencodeBaseUrl: string;
  readOnly?: boolean;
}) {
  const workspaces: WorkspaceInfo[] = [
    {
      id: "ws_1",
      name: "Workspace",
      path: input.workspaceRoot,
      preset: "starter",
      workspaceType: "local",
      baseUrl: input.opencodeBaseUrl,
    },
  ];
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: [input.workspaceRoot],
    readOnly: input.readOnly ?? true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = (await startServer(config)) as Served;
  stops.push(() => server.stop(true));
  return { server, token: config.token };
}

/** A minimal OpenCode database holding the session rows the mock will hand out. */
async function createOpencodeDb(sessionIds: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "openwork-session-transfer-db-"));
  roots.push(dir);
  const dbPath = join(dir, "opencode-test.db");
  const db = new Database(dbPath);
  db.exec(`
    create table session (id text primary key, time_updated integer);
    create table message (
      id text primary key, session_id text not null,
      time_created integer, time_updated integer, data text not null
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer, time_updated integer, data text not null
    );
  `);
  for (const id of sessionIds) {
    db.prepare("insert into session (id, time_updated) values (?, ?)").run(id, 1);
  }
  db.close();
  setEnv("OPENCODE_DB", dbPath);
  return dbPath;
}

describe("session export API", () => {
  test("exports one session as a portable JSON bundle", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_1/export`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      format: "openwork.session-export",
      version: 1,
      workspaceId: "ws_1",
      sessions: [{ session: { id: "ses_1", title: "Hostname Check" } }],
    });
    expect(body.sessions[0].messages).toHaveLength(2);
    expect(body.sessions[0].todos).toEqual([
      { content: "Validate exports", status: "completed", priority: "high" },
    ]);
    expect(typeof body.exportedAt).toBe("string");
  });

  test("exports one session as shareable markdown", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_1/export?format=markdown`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    const markdown = await response.text();
    expect(markdown).toContain("# Hostname Check");
    expect(markdown).toContain("What host am I on?");
    expect(markdown).toContain("hostname: mock-host");
  });

  test("exports every session in the workspace in one bundle", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/export?sensitive=exclude`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sessions.map((entry: { session: { id: string } }) => entry.session.id)).toEqual(["ses_1", "ses_2"]);
  });

  test("refuses to guess when a transcript carries secret-like content", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_2/export`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.code).toBe("session_export_requires_decision");
    expect(body.details.warnings[0].id).toBe("session:ses_2");
  });

  test("redacts the secret when the caller asks to exclude sensitive content", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_2/export?sensitive=exclude`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[redacted]");
  });

  test("keeps the secret when the caller explicitly opts in", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_2/export?sensitive=include`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(SECRET);
  });

  test("does not read a session that belongs to another workspace directory", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ sessionDirectory: "/somewhere/else" });
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_1/export`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "session_not_found" });
  });
});

describe("session import API", () => {
  async function exportBundle(port: number, token: string) {
    const response = await fetch(`http://127.0.0.1:${port}/workspace/ws_1/sessions/ses_1/export`, {
      headers: auth(token),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  test("round-trips an exported bundle back into new sessions", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    const dbPath = await createOpencodeDb(["ses_created_1"]);

    const bundle = await exportBundle(openwork.server.port, openwork.token);

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/import`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      imported: [{ sourceSessionId: "ses_1", sessionId: "ses_created_1", title: "Hostname Check", messages: 2 }],
    });

    const db = new Database(dbPath, { readonly: true });
    const rows = db
      .query("select session_id, data from part order by time_created asc")
      .all() as Array<{ session_id: string; data: string }>;
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.session_id === "ses_created_1")).toBe(true);
    expect(rows.map((row) => JSON.parse(row.data).text)).toEqual(["What host am I on?", "hostname: mock-host"]);
  });

  test("imports every session from a workspace bundle", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    await createOpencodeDb(["ses_created_1", "ses_created_2"]);

    const exported = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/export?sensitive=exclude`,
      { headers: auth(openwork.token) },
    );
    const bundle = await exported.json();

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/import`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.imported.map((item: { sourceSessionId: string }) => item.sourceSessionId)).toEqual(["ses_1", "ses_2"]);
  });

  test("rejects a file that is not a session bundle", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/import`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_session_bundle" });
  });

  test("refuses to import into a read-only server", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: true,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/import`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(201);
  });
});

describe("imported sessions are read-only", () => {
  async function importOneSession() {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    await createOpencodeDb(["ses_created_1"]);

    const exported = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_1/export`,
      { headers: auth(openwork.token) },
    );
    const bundle = await exported.json();
    const importResponse = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/import`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify(bundle),
    });
    expect(importResponse.status).toBe(201);
    return { openwork, mock, base: `http://127.0.0.1:${openwork.server.port}` };
  }

  test("records where an imported session came from", async () => {
    const { base, openwork } = await importOneSession();

    const response = await fetch(`${base}/workspace/ws_1/session-imports`, { headers: auth(openwork.token) });
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.marks.ses_created_1).toMatchObject({
      sourceWorkspaceId: "ws_1",
      sourceWorkspaceName: "Workspace",
      sourceSessionId: "ses_1",
    });
    expect(typeof body.marks.ses_created_1.importedAt).toBe("number");
  });

  test("blocks a prompt to an imported session at the proxy", async () => {
    const { base, openwork, mock } = await importOneSession();

    const response = await fetch(`${base}/workspace/ws_1/opencode/session/ses_created_1/prompt`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "keep going" }] }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "session_read_only" });
    expect(mock.promptedSessionIds).toEqual([]);
  });

  test("still allows prompting a session that was not imported", async () => {
    const { base, openwork, mock } = await importOneSession();

    const response = await fetch(`${base}/workspace/ws_1/opencode/session/ses_1/prompt`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
    });

    expect(response.status).toBe(200);
    expect(mock.promptedSessionIds).toEqual(["ses_1"]);
  });

  test("still allows managing an imported session", async () => {
    const { base, openwork } = await importOneSession();

    const renamed = await fetch(`${base}/workspace/ws_1/opencode/session/ses_created_1`, {
      method: "PATCH",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });

    expect(renamed.status).toBe(200);
  });

  test("forgets provenance when the imported session is deleted", async () => {
    const { base, openwork } = await importOneSession();

    const deleted = await fetch(`${base}/workspace/ws_1/sessions/ses_created_1`, {
      method: "DELETE",
      headers: auth(openwork.token),
    });
    expect(deleted.status).toBe(200);

    const response = await fetch(`${base}/workspace/ws_1/session-imports`, { headers: auth(openwork.token) });
    const body = await response.json();
    expect(body.marks.ses_created_1).toBeUndefined();
  });
});
