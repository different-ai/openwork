import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  listClaudeCodeSessionsEverywhere,
  readClaudeCodeSessionEverywhere,
} from "../src/code-sessions/claude-code.ts";
import {
  listCodexSessionsEverywhere,
  readCodexSessionEverywhere,
} from "../src/code-sessions/codex.ts";
import {
  listPiSessionsEverywhere,
  readPiSessionEverywhere,
} from "../src/code-sessions/pi.ts";
import {
  listOpenCodeSessionsEverywhere,
  readOpenCodeSessionEverywhere,
} from "../src/code-sessions/opencode.ts";
import { createCodeSessionsService } from "../src/code-sessions/index.ts";
import { createDriveRegistry } from "../src/code-sessions/drive.ts";

const FOLDER_A = "E--Proyectos-Kizuna";
const FOLDER_B = "C--Users-dev-api";

function row(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

const DEPLOY_SESSION = [
  row({ type: "summary", summary: "Fix the deploy script", leafUuid: "u4" }),
  row({
    type: "user", uuid: "u1", parentUuid: null, sessionId: "s-deploy",
    timestamp: "2026-10-28T10:00:00.000Z", cwd: "E:\\Proyectos\\Kizuna",
    message: { role: "user", content: "Fix the deploy script" },
  }),
  row({
    type: "assistant", uuid: "u2", parentUuid: "u1", sessionId: "s-deploy",
    timestamp: "2026-10-28T10:00:05.000Z", cwd: "E:\\Proyectos\\Kizuna",
    message: { role: "assistant", model: "claude-x", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
  }),
  row({
    type: "user", uuid: "u3", parentUuid: "u2", sessionId: "s-deploy",
    timestamp: "2026-10-28T10:00:06.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "deploy.sh" }] },
  }),
  row({
    type: "assistant", uuid: "u4", parentUuid: "u3", sessionId: "s-deploy",
    timestamp: "2026-10-28T10:00:07.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Deploy fixed." }] },
  }),
].join("");

const PLAIN_SESSION = [
  row({
    type: "user", uuid: "v1", parentUuid: null, sessionId: "s-plain",
    timestamp: "2026-10-28T09:00:00.000Z", cwd: "E:\\Proyectos\\Kizuna",
    message: { role: "user", content: "What changed today?" },
  }),
  row({
    type: "assistant", uuid: "v2", parentUuid: "v1", sessionId: "s-plain",
    timestamp: "2026-10-28T09:00:04.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Three files." }] },
  }),
].join("");

const API_SESSION = [
  row({
    type: "user", uuid: "w1", parentUuid: null, sessionId: "s-api",
    timestamp: "2026-10-28T12:00:00.000Z", cwd: "C:\\Users\\dev\\api",
    message: { role: "user", content: "Add the health endpoint" },
  }),
].join("");

async function makeConfigDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "code-sessions-"));
  const folderA = join(configDir, "projects", FOLDER_A);
  const folderB = join(configDir, "projects", FOLDER_B);
  await mkdir(folderA, { recursive: true });
  await mkdir(folderB, { recursive: true });
  const deploy = join(folderA, "s-deploy.jsonl");
  const plain = join(folderA, "s-plain.jsonl");
  await writeFile(deploy, DEPLOY_SESSION);
  await writeFile(plain, PLAIN_SESSION);
  const api = join(folderB, "s-api.jsonl");
  await writeFile(api, API_SESSION);
  // deterministic ordering: deploy newest, then api, then plain
  await utimes(deploy, new Date("2026-10-28T10:00:07Z"), new Date("2026-10-28T10:00:07Z"));
  await utimes(plain, new Date("2026-10-28T09:00:04Z"), new Date("2026-10-28T09:00:04Z"));
  await utimes(api, new Date("2026-10-28T08:00:00Z"), new Date("2026-10-28T08:00:00Z"));
  await writeFile(join(folderA, "notes.txt"), "not a transcript");
  return configDir;
}

test("the machine-wide list finds sessions across projects, newest first, with real project paths", async () => {
  const configDir = await makeConfigDir();
  const items = await listClaudeCodeSessionsEverywhere({ configDir });

  expect(items.map((item) => item.sessionId)).toEqual([
    `${FOLDER_A}/s-deploy`,
    `${FOLDER_A}/s-plain`,
    `${FOLDER_B}/s-api`,
  ]);
  expect(items[0]?.projectPath).toBe("E:\\Proyectos\\Kizuna");
  expect(items[2]?.projectPath).toBe("C:\\Users\\dev\\api");
  expect(items[0]?.title).toBe("Fix the deploy script");
  expect(items[2]?.title).toBe("Claude Code session");
  expect(items[0]?.client).toBe("claude-code");
});

test("a transcript above the size cap is not offered", async () => {
  const configDir = await makeConfigDir();
  const items = await listClaudeCodeSessionsEverywhere({ configDir, maxTranscriptBytes: 10 });
  expect(items).toEqual([]);
});

test("reading a session returns the neutral transcript with tool calls resolved", async () => {
  const configDir = await makeConfigDir();
  const detail = await readClaudeCodeSessionEverywhere(`${FOLDER_A}/s-deploy`, { configDir });

  expect(detail.summary.projectPath).toBe("E:\\Proyectos\\Kizuna");
  expect(detail.summary.title).toBe("Fix the deploy script");
  // The tool_result row is not a user turn, and the reply after it merges
  // into the same assistant message: one user, one assistant with two blocks.
  expect(detail.summary.messageCount).toBe(2);
  expect(detail.notes).toEqual([]);

  const [user, answer] = detail.messages;
  expect(user).toMatchObject({ role: "user", text: "Fix the deploy script" });
  expect(answer).toMatchObject({
    role: "assistant",
    blocks: [
      { type: "tool", call: { name: "Bash", output: "deploy.sh", failed: false } },
      { type: "text", text: "Deploy fixed." },
    ],
  });
});

test("a session id cannot escape the transcripts folder", async () => {
  const configDir = await makeConfigDir();
  await expect(readClaudeCodeSessionEverywhere("../secrets/passwords", { configDir }))
    .rejects.toMatchObject({ code: "code_session_not_found" });
  await expect(readClaudeCodeSessionEverywhere(`${FOLDER_A}/../../etc/passwd`, { configDir }))
    .rejects.toMatchObject({ code: "code_session_not_found" });
  await expect(readClaudeCodeSessionEverywhere(`${FOLDER_A}/missing-session`, { configDir }))
    .rejects.toMatchObject({ code: "code_session_not_found" });
});

test("turning a client off stops scanning and reading it", async () => {
  const configDir = await makeConfigDir();
  const emptyCodex = await mkdtemp(join(tmpdir(), "empty-codex-"));
  await mkdir(join(emptyCodex, "sessions"), { recursive: true });
  const emptyPi = await mkdtemp(join(tmpdir(), "empty-pi-"));
  const emptyOcDir = await mkdtemp(join(tmpdir(), "empty-oc-"));
  const emptyOcDb = join(emptyOcDir, "opencode.db");
  await (await import("node:fs/promises")).writeFile(emptyOcDb, "");
  const service = createCodeSessionsService({
    claudeConfigDir: () => configDir,
    codexConfigDir: () => emptyCodex,
    piSessionsDir: () => emptyPi,
    opencodeDbPath: () => emptyOcDb,
  });

  expect((await service.list()).length).toBe(3);
  service.setClientEnabled("claude-code", false);

  expect(service.clients()).toEqual([
    { id: "claude-code", enabled: false, available: true },
    { id: "codex", enabled: true, available: true },
    { id: "pi", enabled: true, available: true },
    { id: "opencode", enabled: true, available: true },
  ]);
  expect(await service.list()).toEqual([]);
  await expect(service.read("claude-code", `${FOLDER_A}/s-deploy`))
    .rejects.toMatchObject({ code: "code_session_client_disabled" });
  await expect(service.read("nope", "x/y"))
    .rejects.toMatchObject({ code: "code_session_client_unknown" });
});

// ---------------------------------------------------------------------------
// Codex rollouts (format observed in real Codex CLI 0.148 files)

const CODEX_DAY = "2026/08/20";
const CODEX_FILE = "rollout-2026-08-20T03-59-42-01a01ce5-426e-7292-aa7e-2bae82277319.jsonl";

function codexRow(type: string, payload: Record<string, unknown>, timestamp: string): string {
  return `${JSON.stringify({ timestamp, ordinal: 0, type, payload })}\n`;
}

async function makeCodexDir(): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "codex-sessions-"));
  const dayDir = join(configDir, "sessions", "2026", "08", "20");
  await mkdir(dayDir, { recursive: true });
  const rollout = [
    codexRow("session_meta", { session_id: "01a01ce5", cwd: "D:\\Proyectos\\WIP" }, "2026-08-20T06:33:03Z"),
    codexRow("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>nope</skills_instructions>" }] }, "2026-08-20T06:33:04Z"),
    codexRow("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Verify this against the docs" }] }, "2026-08-20T06:33:05Z"),
    codexRow("response_item", { type: "reasoning", content: [{ type: "reasoning_text", text: "Check scapy docs first." }] }, "2026-08-20T06:33:06Z"),
    codexRow("response_item", { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"curl docs\"}", call_id: "call_1" }, "2026-08-20T06:33:07Z"),
    codexRow("response_item", { type: "function_call_output", call_id: "call_1", output: "aborted by user" }, "2026-08-20T06:33:08Z"),
    codexRow("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Docs **verified**." }] }, "2026-08-20T06:33:09Z"),
    codexRow("event_msg", { type: "token_count" }, "2026-08-20T06:33:10Z"),
  ].join("");
  await writeFile(join(dayDir, CODEX_FILE), rollout);
  return configDir;
}

test("the Codex list finds rollouts with real cwd and first user prompt as title", async () => {
  const configDir = await makeCodexDir();
  const items = await listCodexSessionsEverywhere({ configDir });

  expect(items.length).toBe(1);
  expect(items[0]?.client).toBe("codex");
  expect(items[0]?.sessionId).toBe(`${CODEX_DAY}/${CODEX_FILE.slice(0, -".jsonl".length)}`);
  expect(items[0]?.projectPath).toBe("D:\\Proyectos\\WIP");
  expect(items[0]?.title).toBe("Verify this against the docs");
});

test("reading a Codex rollout skips packaging, resolves tool output and merges the reply", async () => {
  const configDir = await makeCodexDir();
  const detail = await readCodexSessionEverywhere(`${CODEX_DAY}/${CODEX_FILE.slice(0, -".jsonl".length)}`, { configDir });

  expect(detail.summary.projectPath).toBe("D:\\Proyectos\\WIP");
  expect(detail.summary.messageCount).toBe(2);
  const [user, answer] = detail.messages;
  expect(user).toMatchObject({ role: "user", text: "Verify this against the docs" });
  expect(answer?.role).toBe("assistant");
  expect(answer?.role === "assistant" && answer.blocks).toEqual([
    { type: "reasoning", text: "Check scapy docs first." },
    { type: "tool", call: { id: "call_1", name: "exec_command", input: { cmd: "curl docs" }, output: "aborted by user", failed: false, time: expect.any(Number) } },
    { type: "text", text: "Docs **verified**." },
  ]);
});

test("a Codex session id cannot escape the rollouts folder", async () => {
  const configDir = await makeCodexDir();
  await expect(readCodexSessionEverywhere("2026/08/../../etc/rollout-x.jsonl", { configDir }))
    .rejects.toMatchObject({ code: "code_session_not_found" });
});

// ---------------------------------------------------------------------------
// Pi sessions (fixture-only validation: no live Pi data on this machine)

async function makePiDir(): Promise<string> {
  const sessionsDir = await mkdtemp(join(tmpdir(), "pi-sessions-"));
  const folder = await mkdtemp(join(sessionsDir, "proj-"));
  const session = [
    `${JSON.stringify({ type: "message", timestamp: 1793200000, message: { id: "u1", role: "user", content: [{ type: "text", text: "Build the dashboard" }] } })}\n`,
    `${JSON.stringify({ type: "message", timestamp: 1793200005, message: { id: "a1", role: "assistant", content: [{ type: "thinking", thinking: "Planning widgets." }, { type: "toolCall", id: "t1", name: "write", arguments: { path: "app.tsx" } }] } })}\n`,
    `${JSON.stringify({ type: "message", timestamp: 1793200006, message: { id: "tr1", role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "written" }] } })}\n`,
    `${JSON.stringify({ type: "message", timestamp: 1793200007, message: { id: "a2", role: "assistant", content: [{ type: "text", text: "Dashboard built." }] } })}\n`,
  ].join("");
  await writeFile(join(folder, "session-abc.jsonl"), session);
  return sessionsDir;
}

test("the Pi list finds sessions and the read resolves tool results", async () => {
  const sessionsDir = await makePiDir();
  const items = await listPiSessionsEverywhere({ sessionsDir });
  expect(items.length).toBe(1);
  expect(items[0]?.client).toBe("pi");

  const detail = await readPiSessionEverywhere(items[0]!.sessionId, { sessionsDir });
  expect(detail.summary.messageCount).toBe(3);
  const [, reply, closing] = detail.messages;
  expect(reply?.role).toBe("assistant");
  expect(reply?.role === "assistant" && reply.blocks[0]).toMatchObject({ type: "reasoning", text: "Planning widgets." });
  expect(reply?.role === "assistant" && reply.blocks[1]).toMatchObject({ type: "tool", call: { name: "write", output: "written", failed: false } });
  expect(closing).toMatchObject({ role: "assistant" });
});

// ---------------------------------------------------------------------------
// OpenCode v2 SQLite storage

async function makeOpenCodeDb(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "oc-v2-"));
  const dbPath = join(dir, "opencode.db");
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?)").run(
    "ses_fixture01", "C:/Proyectos/Kizuna", "Mirror fixture", 1793200000000, 1793200010000,
  );
  const insMsg = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
  const insPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  insMsg.run("m1", "ses_fixture01", 1793200001000, 1793200001000, JSON.stringify({ role: "user", time: { created: 1793200001000 } }));
  insPart.run("p1", "m1", "ses_fixture01", 1793200001000, 1793200001000, JSON.stringify({ type: "text", text: "Check the mirror" }));
  insMsg.run("m2", "ses_fixture01", 1793200002000, 1793200009000, JSON.stringify({ role: "assistant", time: { created: 1793200002000 } }));
  insPart.run("p2", "m2", "ses_fixture01", 1793200002000, 1793200002000, JSON.stringify({ type: "reasoning", text: "Look at the files." }));
  insPart.run("p3", "m2", "ses_fixture01", 1793200003000, 1793200003000, JSON.stringify({ type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" }, output: "file.ts", time: { start: 1793200003000, end: 1793200004000 } } }));
  insPart.run("p4", "m2", "ses_fixture01", 1793200005000, 1793200005000, JSON.stringify({ type: "text", text: "Done." }));
  db.close();
  return dbPath;
}

test("the OpenCode v2 mirror lists sessions and transcodes parts", async () => {
  const dbPath = await makeOpenCodeDb();
  const items = await listOpenCodeSessionsEverywhere({ dbPath });

  expect(items.length).toBe(1);
  expect(items[0]).toMatchObject({
    client: "opencode",
    sessionId: "ses_fixture01",
    projectPath: "C:\\Proyectos\\Kizuna",
    title: "Mirror fixture",
  });

  const detail = await readOpenCodeSessionEverywhere("ses_fixture01", { dbPath });
  expect(detail.summary.messageCount).toBe(2);
  const [user, reply] = detail.messages;
  expect(user).toMatchObject({ role: "user", text: "Check the mirror" });
  expect(reply?.role === "assistant" && reply.blocks).toEqual([
    { type: "reasoning", text: "Look at the files." },
    { type: "tool", call: { id: "c1", name: "bash", input: { command: "ls" }, output: "file.ts", failed: false, time: 1793200003000 } },
    { type: "text", text: "Done." },
  ]);
});

test("an OpenCode session id that is not a session id is rejected", async () => {
  const dbPath = await makeOpenCodeDb();
  await expect(readOpenCodeSessionEverywhere("../evil", { dbPath }))
    .rejects.toMatchObject({ code: "code_session_not_found" });
  await expect(readOpenCodeSessionEverywhere("msg_notasession", { dbPath }))
    .rejects.toMatchObject({ code: "code_session_not_found" });
});

// ---------------------------------------------------------------------------
// Driven mode registry (spawn injected: no real agent runs in tests)

function until<T>(probe: () => T | undefined, check: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = probe();
      if (value !== undefined && check(value)) { resolve(value); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error("drive condition timed out")); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

test("a drive run starts, completes and is reported", async () => {
  const drives = createDriveRegistry({
    spawnSpec: () => ({ file: process.execPath, args: ["-e", "process.exit(0)"] }),
  });
  const run = drives.start({ client: "claude-code", sessionId: "ses_x", cwd: process.cwd(), prompt: "hi" });
  expect(run.status).toBe("running");

  const finished = await until(() => drives.get(run.id), (value) => value.status !== "running");
  expect(finished.status).toBe("completed");
});

test("a failing run surfaces its stderr tail", async () => {
  const drives = createDriveRegistry({
    spawnSpec: () => ({ file: process.execPath, args: ["-e", "console.error('boom reason'); process.exit(3)"] }),
  });
  const run = drives.start({ client: "claude-code", sessionId: "ses_y", cwd: process.cwd(), prompt: "hi" });
  const finished = await until(() => drives.get(run.id), (value) => value.status !== "running");
  expect(finished.status).toBe("failed");
  expect(finished.error).toContain("boom reason");
});

test("one run per session; abort flips the status", async () => {
  const drives = createDriveRegistry({
    spawnSpec: () => ({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] }),
  });
  const run = drives.start({ client: "claude-code", sessionId: "ses_z", cwd: process.cwd(), prompt: "hi" });
  expect(() => drives.start({ client: "claude-code", sessionId: "ses_z", cwd: process.cwd(), prompt: "again" }))
    .toThrowError(/already running/);

  drives.abort(run.id);
  const aborted = await until(() => drives.get(run.id), (value) => value.status === "aborted");
  expect(aborted.status).toBe("aborted");
  expect(drives.list().length).toBe(1);
});
