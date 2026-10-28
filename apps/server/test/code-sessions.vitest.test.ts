import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import {
  listClaudeCodeSessionsEverywhere,
  readClaudeCodeSessionEverywhere,
} from "../src/code-sessions/claude-code.ts";
import { createCodeSessionsService } from "../src/code-sessions/index.ts";

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
  const service = createCodeSessionsService({ claudeConfigDir: () => configDir });

  expect((await service.list()).length).toBe(3);
  service.setClientEnabled("claude-code", false);

  expect(service.clients()).toEqual([{ id: "claude-code", enabled: false, available: true }]);
  expect(await service.list()).toEqual([]);
  await expect(service.read("claude-code", `${FOLDER_A}/s-deploy`))
    .rejects.toMatchObject({ code: "code_session_client_disabled" });
});
