import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { startServer } from "../../apps/server/src/server.js";
import type { ServerConfig } from "../../apps/server/src/types.js";
import {
  readSessionBundleFile,
  sessionExportFilename,
  workspaceSessionsExportFilename,
} from "../../apps/app/src/app/lib/session-transfer.js";
import {
  isSessionImported,
  partitionImportedSessions,
} from "../../apps/app/src/react-app/domains/session/sidebar/utils.js";

/**
 * Session export/import: a session must be able to leave OpenWork as a
 * shareable file and come back as a real session, without smuggling secrets
 * out of the transcript.
 */

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123";

type Cleanup = () => Promise<void> | void;

function jsonBody(payload: unknown): string {
  return JSON.stringify(payload);
}

/** An OpenCode stand-in: one plain session, one whose transcript leaks a token. */
function startMockOpencode(options: { sessionDirectory?: string } = {}) {
  const createdSessionIds: string[] = [];
  const promptedSessionIds: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const directory = options.sessionDirectory ?? (request.headers["x-opencode-directory"] as string | undefined) ?? "";
    const session = (id: string, title: string) => ({
      id,
      title,
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      directory,
      time: { created: 100, updated: 200 },
    });

    const send = (payload: unknown, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(jsonBody(payload));
    };

    if (url.pathname === "/session" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let title = "New session";
        try {
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          if (parsed && typeof parsed === "object" && typeof Reflect.get(parsed, "title") === "string") {
            title = String(Reflect.get(parsed, "title"));
          }
        } catch {
          // keep the fallback title
        }
        const id = `ses_created_${createdSessionIds.length + 1}`;
        createdSessionIds.push(id);
        send(session(id, title));
      });
      return;
    }

    if (url.pathname === "/session") {
      send([session("ses_1", "Hostname Check"), session("ses_2", "Deploy notes")]);
      return;
    }
    if (url.pathname === "/session/status") {
      send({ ses_1: { type: "idle" }, ses_2: { type: "idle" } });
      return;
    }
    if (url.pathname === "/session/ses_1") return send(session("ses_1", "Hostname Check"));
    if (url.pathname === "/session/ses_2") return send(session("ses_2", "Deploy notes"));
    if (url.pathname === "/session/ses_1/todo") return send([]);
    if (url.pathname === "/session/ses_2/todo") return send([]);

    const createdMatch = url.pathname.match(/^\/session\/(ses_created_\d+)$/);
    if (createdMatch?.[1] && request.method === "GET") {
      return send(session(createdMatch[1], "Imported session"));
    }

    if (/^\/session\/[^/]+\/prompt$/.test(url.pathname) && request.method === "POST") {
      promptedSessionIds.push(url.pathname.split("/")[2] ?? "");
      return send({ ok: true });
    }

    if (url.pathname === "/session/ses_1/message") {
      return send([
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
      return send([
        {
          info: { id: "msg_3", sessionID: "ses_2", role: "assistant", time: { created: 200 } },
          parts: [
            {
              id: "prt_3",
              messageID: "msg_3",
              sessionID: "ses_2",
              type: "text",
              text: `Deploy finished. Run: export GITHUB_TOKEN=${SECRET}`,
            },
          ],
        },
      ]);
    }

    send({ code: "not_found", message: "Not found" }, 404);
  });

  return new Promise<{ port: number; stop: Cleanup; createdSessionIds: string[]; promptedSessionIds: string[] }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        port: address.port,
        stop: () => new Promise<void>((done) => (server as Server).close(() => done())),
        createdSessionIds,
        promptedSessionIds,
      });
    });
  });
}

async function startOpenwork(input: { workspaceRoot: string; opencodePort: number; readOnly?: boolean }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_spec_token",
    hostToken: "owt_spec_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${input.opencodePort}`,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: input.readOnly ?? true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  return {
    base: `http://127.0.0.1:${server.port}`,
    token: config.token,
    stop: () => server.stop(),
  };
}

async function withStack(
  options: { sessionDirectory?: string; readOnly?: boolean },
  run: (stack: {
    base: string;
    token: string;
    workspaceRoot: string;
    promptedSessionIds: string[];
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-transfer-spec-"));
  await mkdir(join(root, ".opencode"), { recursive: true });
  // Import provenance is stored in the OpenWork runtime database. Point it at a
  // throwaway file so a test never writes to the developer's real profile.
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const mock = await startMockOpencode({ ...(options.sessionDirectory ? { sessionDirectory: options.sessionDirectory } : {}) });
  const openwork = await startOpenwork({
    workspaceRoot: root,
    opencodePort: mock.port,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  try {
    await run({
      base: openwork.base,
      token: openwork.token,
      workspaceRoot: root,
      promptedSessionIds: mock.promptedSessionIds,
    });
  } finally {
    await openwork.stop();
    await mock.stop();
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    await rm(root, { recursive: true, force: true });
  }
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ExportedSession = { id: string; messageCount: number };
type ExportedBundle = { format: string; version: number; sessions: ExportedSession[] };

function parseBundle(payload: unknown): ExportedBundle {
  if (!isRecord(payload) || typeof payload.format !== "string" || typeof payload.version !== "number") {
    throw new Error("Export response is not a session bundle.");
  }
  if (!Array.isArray(payload.sessions)) throw new Error("Export bundle has no sessions array.");
  const sessions: ExportedSession[] = [];
  for (const entry of payload.sessions) {
    if (!isRecord(entry) || !isRecord(entry.session) || typeof entry.session.id !== "string") {
      throw new Error("Export bundle session entry is malformed.");
    }
    sessions.push({
      id: entry.session.id,
      messageCount: Array.isArray(entry.messages) ? entry.messages.length : 0,
    });
  }
  return { format: payload.format, version: payload.version, sessions };
}

type ImportedSession = { sourceSessionId: string; sessionId: string; messages: number };

function parseImportResult(payload: unknown): { ok: boolean; imported: ImportedSession[] } {
  if (!isRecord(payload) || !Array.isArray(payload.imported)) {
    throw new Error("Import response is malformed.");
  }
  const imported: ImportedSession[] = [];
  for (const entry of payload.imported) {
    if (
      !isRecord(entry)
      || typeof entry.sourceSessionId !== "string"
      || typeof entry.sessionId !== "string"
      || typeof entry.messages !== "number"
    ) {
      throw new Error("Import result entry is malformed.");
    }
    imported.push({
      sourceSessionId: entry.sourceSessionId,
      sessionId: entry.sessionId,
      messages: entry.messages,
    });
  }
  return { ok: payload.ok === true, imported };
}

function parseErrorBody(payload: unknown): { code: string; warningIds: string[] } {
  if (!isRecord(payload) || typeof payload.code !== "string") {
    throw new Error("Error response has no code.");
  }
  const warnings = isRecord(payload.details) && Array.isArray(payload.details.warnings)
    ? payload.details.warnings
    : [];
  const warningIds = warnings.flatMap((warning) => (
    isRecord(warning) && typeof warning.id === "string" ? [warning.id] : []
  ));
  return { code: payload.code, warningIds };
}

type SessionImportMarkResponse = {
  sourceWorkspaceId: string;
  sourceWorkspaceName: string;
  sourceSessionId: string;
  importedAt: number;
};

function parseImportMark(payload: unknown, sessionId: string): SessionImportMarkResponse {
  if (!isRecord(payload) || !isRecord(payload.marks)) {
    throw new Error("Session imports response is malformed.");
  }
  const mark = payload.marks[sessionId];
  if (
    !isRecord(mark)
    || typeof mark.sourceWorkspaceId !== "string"
    || typeof mark.sourceWorkspaceName !== "string"
    || typeof mark.sourceSessionId !== "string"
    || typeof mark.importedAt !== "number"
  ) {
    throw new Error(`No import provenance recorded for ${sessionId}.`);
  }
  return {
    sourceWorkspaceId: mark.sourceWorkspaceId,
    sourceWorkspaceName: mark.sourceWorkspaceName,
    sourceSessionId: mark.sourceSessionId,
    importedAt: mark.importedAt,
  };
}

function parseSessionIds(payload: unknown): string[] {  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error("Session list response is malformed.");
  }
  return payload.items.flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : []));
}

function parsePartRows(rows: unknown): Array<{ session_id: string; data: string }> {
  if (!Array.isArray(rows)) throw new Error("Engine part query did not return rows.");
  return rows.map((row) => {
    if (!isRecord(row) || typeof row.session_id !== "string" || typeof row.data !== "string") {
      throw new Error("Engine part row is malformed.");
    }
    return { session_id: row.session_id, data: row.data };
  });
}

function parsePartTexts(rows: Array<{ session_id: string; data: string }>): string[] {
  return rows.map((row) => {
    const parsed: unknown = JSON.parse(row.data);
    if (!isRecord(parsed) || typeof parsed.text !== "string") {
      throw new Error("Stored part has no text.");
    }
    return parsed.text;
  });
}

test("a session leaves OpenWork as a shareable bundle and can be read back", async ({ evidence }) => {
  await withStack({}, async ({ base, token }) => {
    const jsonResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/export`, { headers: authHeaders(token) });
    expect(jsonResponse.status).toBe(200);
    const bundle = parseBundle(await jsonResponse.json());

    expect(bundle.format).toBe("openwork.session-export");
    expect(bundle.version).toBe(1);
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]?.id).toBe("ses_1");
    expect(bundle.sessions[0]?.messageCount).toBe(2);
    evidence.recordAssertionEvidence(
      "Positive: one session exports as a versioned, self-describing bundle",
      `GET /sessions/ses_1/export returned format="${bundle.format}" version=${bundle.version} carrying 1 session and ${bundle.sessions[0]?.messageCount} messages, so the file identifies itself and holds the full transcript.`,
      true,
    );

    const markdownResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/export?format=markdown`, {
      headers: authHeaders(token),
    });
    const markdown = await markdownResponse.text();
    expect(markdownResponse.headers.get("content-type")).toContain("text/markdown");
    expect(markdown).toContain("# Hostname Check");
    expect(markdown).toContain("What host am I on?");
    expect(markdown).toContain("hostname: mock-host");
    expect(markdown).not.toContain("\"parts\"");
    evidence.recordAssertionEvidence(
      "Positive: the same session renders as a readable transcript",
      "format=markdown returned text/markdown containing the session title and both turns in reading order, and none of the raw JSON part scaffolding, so it can be pasted into an issue or shared directly.",
      true,
    );
  });
});

test("exports strip secrets from a transcript without destroying the message", async ({ evidence }) => {
  await withStack({}, async ({ base, token }) => {
    const undecided = await fetch(`${base}/workspace/ws_1/sessions/ses_2/export`, { headers: authHeaders(token) });
    expect(undecided.status).toBe(409);
    const refusal = parseErrorBody(await undecided.json());
    expect(refusal.code).toBe("session_export_requires_decision");
    expect(refusal.warningIds).toEqual(["session:ses_2"]);
    evidence.recordAssertionEvidence(
      "Positive: a transcript carrying a token is never exported by default",
      `An export with no sensitive-content decision was refused with 409 ${refusal.code} and named the offending session (${refusal.warningIds[0]}), so a credential cannot leave silently.`,
      true,
    );

    const redacted = await fetch(`${base}/workspace/ws_1/sessions/ses_2/export?sensitive=exclude`, {
      headers: authHeaders(token),
    });
    const redactedText = await redacted.text();
    expect(redacted.status).toBe(200);
    expect(redactedText).not.toContain(SECRET);
    expect(redactedText).toContain("[redacted]");
    expect(redactedText).toContain("Deploy finished.");
    evidence.recordAssertionEvidence(
      "Negative: redaction removes the credential but keeps the conversation",
      "sensitive=exclude returned a bundle with the token absent and replaced by [redacted], while the surrounding sentence \"Deploy finished.\" survived, so sharing stays useful instead of blanking the message.",
      true,
    );

    const optedIn = await fetch(`${base}/workspace/ws_1/sessions/ses_2/export?sensitive=include`, {
      headers: authHeaders(token),
    });
    expect(await optedIn.text()).toContain(SECRET);
    evidence.recordAssertionEvidence(
      "Negative: an explicit opt-in still returns the original transcript",
      "sensitive=include returned the untouched token, so redaction is a default rather than an irreversible loss of data.",
      true,
    );
  });
});

test("a workspace exports every session, and only its own", async ({ evidence }) => {
  await withStack({}, async ({ base, token }) => {
    const response = await fetch(`${base}/workspace/ws_1/sessions/export?sensitive=exclude`, {
      headers: authHeaders(token),
    });
    expect(response.status).toBe(200);
    const bundle = parseBundle(await response.json());
    const ids = bundle.sessions.map((entry) => entry.id);

    expect(ids).toEqual(["ses_1", "ses_2"]);
    expect(bundle.format).toBe("openwork.session-export");
    evidence.recordAssertionEvidence(
      "Positive: a per-workspace export carries every session in one envelope",
      `GET /sessions/export returned ${ids.length} sessions (${ids.join(", ")}) in the same bundle shape as a single-session export, so one file can move a whole workspace's history.`,
      true,
    );
  });

  await withStack({ sessionDirectory: "/somewhere/else" }, async ({ base, token }) => {
    const response = await fetch(`${base}/workspace/ws_1/sessions/ses_1/export`, { headers: authHeaders(token) });
    expect(response.status).toBe(404);
    const body = parseErrorBody(await response.json());
    expect(body.code).toBe("session_not_found");
    evidence.recordAssertionEvidence(
      "Negative: a session outside the workspace directory cannot be exported through it",
      `A session whose directory is /somewhere/else was refused with 404 ${body.code}, so export cannot be used to read another workspace's conversations.`,
      true,
    );
  });
});

test("an exported bundle imports back into a real, readable session", async ({ evidence }) => {
  const dbDir = await mkdtemp(join(tmpdir(), "openwork-session-transfer-db-"));
  const dbPath = join(dbDir, "opencode-spec.db");
  const seeded = new DatabaseSync(dbPath);
  seeded.exec(`
    create table session (id text primary key, time_updated integer);
    create table message (
      id text primary key, session_id text not null,
      time_created integer, time_updated integer, data text not null
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer, time_updated integer, data text not null
    );
    insert into session (id, time_updated) values ('ses_created_1', 1);
  `);
  seeded.close();

  const previousDb = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;

  try {
    await withStack({ readOnly: false }, async ({ base, token }) => {
      const exported = await fetch(`${base}/workspace/ws_1/sessions/ses_1/export`, { headers: authHeaders(token) });
      const bundle = await exported.json();

      const imported = await fetch(`${base}/workspace/ws_1/sessions/import`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });

      expect(imported.status).toBe(201);
      const result = parseImportResult(await imported.json());
      const entry = result.imported[0];
      if (!entry) throw new Error("Import reported no sessions.");
      expect(result.ok).toBe(true);
      expect(result.imported).toHaveLength(1);
      expect(entry.sourceSessionId).toBe("ses_1");
      expect(entry.sessionId).toBe("ses_created_1");
      expect(entry.sessionId).not.toBe("ses_1");
      expect(entry.messages).toBe(2);
      evidence.recordAssertionEvidence(
        "Positive: importing a bundle recreates the conversation as a new session",
        `POST /sessions/import accepted the bundle exported from ses_1 and reported 2 messages written into a newly created session (${entry.sessionId}), so a shared file becomes a usable session.`,
        true,
      );

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const partRows = db.prepare("select session_id, data from part order by time_created asc").all();
      const parts = parsePartRows(partRows);
      const texts = parsePartTexts(parts);
      db.close();

      expect(texts).toEqual(["What host am I on?", "hostname: mock-host"]);
      expect(parts.every((row) => row.session_id === "ses_created_1")).toBe(true);
      evidence.recordAssertionEvidence(
        "Positive: the imported transcript is persisted in order under the new session",
        `The engine database holds both turns ("${texts.join('", "')}") in their original order, all attached to the newly created session, so the import is durable rather than a response-shaped illusion.`,
        true,
      );

      expect(entry.sourceSessionId).toBe("ses_1");
      evidence.recordAssertionEvidence(
        "Negative: import never overwrites the session it came from",
        `The original session id (ses_1) is reported only as the bundle's source while the written session is ${entry.sessionId}, so re-importing into the same workspace cannot clobber existing history.`,
        true,
      );
    });
  } finally {
    if (previousDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previousDb;
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("the app names export files predictably and refuses a wrong file before uploading it", ({ evidence }) => {
  expect(sessionExportFilename("Plan the launch", "json")).toBe("Plan-the-launch-openwork-session.json");
  expect(sessionExportFilename("Plan the launch", "markdown")).toBe("Plan-the-launch-openwork-session.md");
  const traversal = sessionExportFilename("  ../../etc/passwd  ", "json");
  expect(traversal).toBe("..-..-etc-passwd-openwork-session.json");
  expect(traversal).not.toContain("/");
  expect(traversal).not.toContain("\\");
  expect(workspaceSessionsExportFilename("Acme Robotics", "json")).toBe("Acme-Robotics-openwork-sessions.json");
  evidence.recordAssertionEvidence(
    "Positive: exported files are named after the session and format",
    `Session and workspace exports produce .json and .md filenames derived from the title, and a title of "../../etc/passwd" became "${traversal}" with no path separator surviving, so a crafted session title cannot steer the download outside its directory.`,
    true,
  );

  const valid = JSON.stringify({
    format: "openwork.session-export",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "ws_1",
    sessions: [{ session: { id: "ses_1" }, messages: [], todos: [] }],
  });
  expect(() => readSessionBundleFile(valid)).not.toThrow();

  expect(() => readSessionBundleFile("not json at all")).toThrow(/not valid JSON/);
  expect(() => readSessionBundleFile(JSON.stringify({ hello: "world" }))).toThrow(/not an OpenWork session export/);
  expect(() => readSessionBundleFile(JSON.stringify({ format: "openwork.session-export", version: 1, sessions: [] })))
    .toThrow(/no sessions/);
  evidence.recordAssertionEvidence(
    "Negative: an unrelated file is rejected in the app before any upload",
    "readSessionBundleFile accepted a real bundle but threw distinct errors for invalid JSON, a JSON file that is not a session export, and an export with an empty session list, so the user gets a specific reason without a server round trip.",
    true,
  );
});

test("an imported session is read-only and says where it came from", async ({ evidence }) => {
  const dbDir = await mkdtemp(join(tmpdir(), "openwork-session-imports-db-"));
  const dbPath = join(dbDir, "opencode-spec.db");
  const seeded = new DatabaseSync(dbPath);
  seeded.exec(`
    create table session (id text primary key, time_updated integer);
    create table message (
      id text primary key, session_id text not null,
      time_created integer, time_updated integer, data text not null
    );
    create table part (
      id text primary key, message_id text not null, session_id text not null,
      time_created integer, time_updated integer, data text not null
    );
    insert into session (id, time_updated) values ('ses_created_1', 1);
  `);
  seeded.close();

  const previousDb = process.env.OPENCODE_DB;
  process.env.OPENCODE_DB = dbPath;

  try {
    await withStack({ readOnly: false }, async ({ base, token, promptedSessionIds }) => {
      const exported = await fetch(`${base}/workspace/ws_1/sessions/ses_1/export`, { headers: authHeaders(token) });
      const bundle = await exported.json();
      const importResponse = await fetch(`${base}/workspace/ws_1/sessions/import`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      expect(importResponse.status).toBe(201);

      const marksResponse = await fetch(`${base}/workspace/ws_1/session-imports`, { headers: authHeaders(token) });
      expect(marksResponse.status).toBe(200);
      const mark = parseImportMark(await marksResponse.json(), "ses_created_1");

      expect(mark.sourceWorkspaceId).toBe("ws_1");
      expect(mark.sourceWorkspaceName).toBe("Workspace");
      expect(mark.sourceSessionId).toBe("ses_1");
      evidence.recordAssertionEvidence(
        "Positive: an imported session records the workspace it came from",
        `GET /session-imports returned provenance for the new session naming source workspace "${mark.sourceWorkspaceName}" and original session ${mark.sourceSessionId}, so the UI can label it instead of showing an unexplained duplicate conversation.`,
        true,
      );

      const blocked = await fetch(`${base}/workspace/ws_1/opencode/session/ses_created_1/prompt`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "keep going" }] }),
      });
      expect(blocked.status).toBe(409);
      expect(parseErrorBody(await blocked.json()).code).toBe("session_read_only");
      expect(promptedSessionIds).toEqual([]);
      evidence.recordAssertionEvidence(
        "Positive: writing to an imported session is refused at the server",
        "A prompt aimed at the imported session was rejected with 409 session_read_only and never reached the engine (the engine recorded zero prompts), so read-only holds for automations and any other client, not just the composer.",
        true,
      );

      const allowed = await fetch(`${base}/workspace/ws_1/opencode/session/ses_1/prompt`, {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ parts: [{ type: "text", text: "hello" }] }),
      });
      expect(allowed.status).toBe(200);
      expect(promptedSessionIds).toEqual(["ses_1"]);
      evidence.recordAssertionEvidence(
        "Negative: sessions that were not imported are unaffected",
        "The same prompt against a normal session in the same workspace succeeded and reached the engine exactly once, so the read-only rule is scoped to imported sessions rather than freezing the workspace.",
        true,
      );
    });
  } finally {
    if (previousDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = previousDb;
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("imported sessions are kept out of the working session list", ({ evidence }) => {
  const sessions = [
    { id: "ses_own_1", title: "Live work" },
    { id: "ses_imported_1", title: "Shared transcript" },
    { id: "ses_own_2", title: "More live work" },
  ];
  const marks = {
    ses_imported_1: { sourceWorkspaceName: "Acme Robotics", sourceSessionId: "ses_1", importedAt: 1 },
  };

  const partitioned = partitionImportedSessions(sessions, marks);

  expect(partitioned.own.map((session) => session.id)).toEqual(["ses_own_1", "ses_own_2"]);
  expect(partitioned.imported.map((session) => session.id)).toEqual(["ses_imported_1"]);
  expect(isSessionImported("ses_imported_1", marks)).toBe(true);
  expect(isSessionImported("ses_own_1", marks)).toBe(false);
  evidence.recordAssertionEvidence(
    "Positive: imported sessions are separated from a workspace's own sessions",
    "Given one marked session among three, the partition returned the two unmarked sessions as the workspace's own working list and the marked one separately, which is what keeps imports in their own sidebar section instead of mixed into live work.",
    true,
  );

  expect(partitionImportedSessions(sessions, undefined).own.map((session) => session.id))
    .toEqual(["ses_own_1", "ses_imported_1", "ses_own_2"]);
  evidence.recordAssertionEvidence(
    "Negative: a workspace with no imports keeps every session in its normal list",
    "With no marks available (for example a workspace whose server could not be reached), all three sessions stayed in the normal list and none were hidden, so a failed provenance lookup can never make sessions disappear.",
    true,
  );
});

test("an unrecognised file is refused instead of creating sessions", async ({ evidence }) => {
  await withStack({ readOnly: false }, async ({ base, token }) => {
    const response = await fetch(`${base}/workspace/ws_1/sessions/import`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(400);
    const body = parseErrorBody(await response.json());
    expect(body.code).toBe("invalid_session_bundle");
    evidence.recordAssertionEvidence(
      "Negative: import rejects anything that is not a session bundle",
      `Posting an arbitrary JSON object was refused with 400 ${body.code} before any session was created, so a wrong file cannot half-populate a workspace.`,
      true,
    );

    const sessions = await fetch(`${base}/workspace/ws_1/sessions`, { headers: authHeaders(token) });
    expect(parseSessionIds(await sessions.json())).toEqual(["ses_1", "ses_2"]);
    evidence.recordAssertionEvidence(
      "Negative: the workspace session list is unchanged after a rejected import",
      "The session list still contained exactly the two pre-existing sessions, confirming the rejected import had no side effect.",
      true,
    );
  });
});
