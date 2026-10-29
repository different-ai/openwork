import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import {
  buildNativeImport,
  ClaudeImportError,
  claudeCodeProjectFolder,
  nativeSessionId,
  readClaudeCodeTranscript,
  readClaudeExport,
} from "../src/claude-import.js";
import { importConversations, readClaudeCodeSessions, type ClaudeImportEngine } from "../src/routes/claude-import.js";

// Synthetic fixtures shaped like Claude's export and Claude Code transcripts.

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const ROOT = "00000000-0000-4000-8000-000000000000";

function chat(extra: Record<string, unknown> = {}) {
  return {
    uuid: "chat-1",
    name: "Plan the offsite",
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:05:00Z",
    account: { uuid: "account-should-not-be-imported" },
    chat_messages: [
      { uuid: "m1", sender: "human", parent_message_uuid: ROOT, created_at: "2026-10-01T10:00:00Z", content: [{ type: "text", text: "Where should we go?" }], attachments: [], files: [] },
      { uuid: "m2", sender: "assistant", parent_message_uuid: "m1", created_at: "2026-10-01T10:00:05Z", updated_at: "2026-10-01T10:00:09Z", content: [
        { type: "thinking", thinking: "Consider budget." },
        { type: "tool_use", id: "t1", name: "web_search", input: { query: "offsite venues" } },
        { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "3 venues" }] },
        { type: "text", text: "Try the lake house." },
      ] },
    ],
    ...extra,
  };
}

describe("Claude export", () => {
  test("reads conversations.json from a ZIP part and keeps text, reasoning and tools", () => {
    const [conversation] = readClaudeExport(zip({ "conversations.json": JSON.stringify([chat()]) }));
    expect(conversation?.title).toBe("Plan the offsite");
    expect(conversation?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const reply = conversation?.messages[1];
    expect(reply?.role === "assistant" ? reply.blocks.map((block) => block.type) : []).toEqual(["reasoning", "tool", "text"]);
  });

  test("explains the download manifest instead of failing vaguely", () => {
    const manifest = Buffer.from(JSON.stringify({ version: "1.0", data_files: [{ category: "conversations", export_url: "https://example.invalid/x" }] }));
    expect(() => readClaudeExport(manifest)).toThrow(ClaudeImportError);
    try { readClaudeExport(manifest); } catch (error) { expect(error instanceof ClaudeImportError && error.code).toBe("claude_export_manifest"); }
  });

  test("the users part of the export is not mistaken for conversations", () => {
    try { readClaudeExport(zip({ "users.json": "[]" })); } catch (error) { expect(error instanceof ClaudeImportError && error.code).toBe("claude_export_empty"); }
  });

  test("imports only the latest branch of an edited conversation", () => {
    const edited = chat();
    edited.chat_messages.splice(1, 0, { uuid: "old", sender: "assistant", parent_message_uuid: "m1", created_at: "2026-10-01T10:00:02Z", content: [{ type: "text", text: "Old answer" }], attachments: [], files: [] });
    const [conversation] = readClaudeExport(Buffer.from(JSON.stringify([edited])));
    expect(JSON.stringify(conversation?.messages)).not.toContain("Old answer");
    expect(conversation?.notes.join(" ")).toContain("latest version");
  });

  test("never carries the Claude account into OpenWork", () => {
    const [conversation] = readClaudeExport(Buffer.from(JSON.stringify([chat()])));
    if (!conversation) throw new Error("missing");
    const payload = buildNativeImport(conversation, { directory: "/work", projectID: "project" });
    expect(JSON.stringify(payload)).not.toContain("account-should-not-be-imported");
    expect(payload.location).toEqual({ directory: "/work" });
    expect(payload.info.location).toEqual({ directory: "/work" });
  });
});

describe("Claude Code transcripts", () => {
  const rows = [
    { type: "custom-title", customTitle: "Fix the login bug", sessionId: "code-1" },
    { type: "user", uuid: "u1", sessionId: "code-1", timestamp: "2026-10-02T09:00:00Z", message: { role: "user", content: "Fix the login bug" } },
    { type: "attachment", uuid: "a1", parentUuid: "u1", sessionId: "code-1" },
    { type: "assistant", uuid: "r1", parentUuid: "a1", sessionId: "code-1", timestamp: "2026-10-02T09:00:02Z", message: { role: "assistant", model: "claude-sonnet", content: [{ type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "login.ts" } }] } },
    { type: "user", uuid: "tr1", parentUuid: "r1", sessionId: "code-1", timestamp: "2026-10-02T09:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "export function login() {}" }] } },
    { type: "assistant", uuid: "r2", parentUuid: "tr1", sessionId: "code-1", timestamp: "2026-10-02T09:00:05Z", message: { role: "assistant", model: "claude-sonnet", content: [{ type: "text", text: "Fixed." }] } },
    { type: "user", uuid: "side", parentUuid: "r2", isSidechain: true, sessionId: "code-1", timestamp: "2026-10-02T09:00:06Z", message: { role: "user", content: "sub-agent prompt" } },
  ];
  const transcript = rows.map((row) => JSON.stringify(row)).join("\n") + "\n{\"truncated";

  test("follows parents through attachments, merges one reply and pairs tool results", () => {
    const conversation = readClaudeCodeTranscript(transcript);
    expect(conversation.title).toBe("Fix the login bug");
    expect(conversation.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const reply = conversation.messages[1];
    if (reply?.role !== "assistant") throw new Error("expected reply");
    expect(reply.blocks.map((block) => block.type)).toEqual(["tool", "text"]);
    const tool = reply.blocks[0];
    expect(tool?.type === "tool" ? tool.call.output : "").toContain("login()");
    expect(JSON.stringify(conversation.messages)).not.toContain("sub-agent prompt");
  });

  test("finds the sessions Claude Code saved for this folder", async () => {
    const home = await mkdtemp(join(tmpdir(), "claude-home-"));
    const folder = join(home, "projects", claudeCodeProjectFolder("/Users/someone/project"));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "code-1.jsonl"), transcript);
    await writeFile(join(folder, "empty.jsonl"), "");
    const sessions = await readClaudeCodeSessions("/Users/someone/project", home);
    expect(sessions.map((session) => session.sourceId)).toEqual(["code-1"]);
  });
});

describe("native import", () => {
  function fakeEngine() {
    const saved = new Map<string, Record<string, unknown>>();
    let posts = 0;
    const engine: ClaudeImportEngine = {
      prepare: async () => undefined,
      request: async (method, path, _directory, body) => {
        if (path === "/api/location") return { status: 200, body: { directory: "/work", project: { id: "project" } } };
        if (method === "POST") {
          posts += 1;
          const info = typeof body === "object" && body !== null && "info" in body ? body.info : undefined;
          if (typeof info === "object" && info !== null && "id" in info && typeof info.id === "string") saved.set(info.id, { ...info });
          return { status: 200, body: { data: info } };
        }
        const id = decodeURIComponent(path.split("/").pop() ?? "");
        const info = saved.get(id);
        return info ? { status: 200, body: { data: info } } : { status: 404, body: undefined };
      },
    };
    return { engine, posts: () => posts, saved };
  }

  test("imports once, recognises a re-import, and never overwrites a changed one", async () => {
    const [conversation] = readClaudeExport(Buffer.from(JSON.stringify([chat()])));
    if (!conversation) throw new Error("missing");
    const { engine, posts, saved } = fakeEngine();
    expect((await importConversations(engine, [conversation], "/work"))[0]?.status).toBe("imported");
    expect((await importConversations(engine, [conversation], "/work"))[0]?.status).toBe("already_imported");
    const id = nativeSessionId(conversation, "/work");
    saved.set(id, { metadata: { claudeImport: { sourceHash: "edited-elsewhere" } } });
    expect((await importConversations(engine, [conversation], "/work"))[0]?.status).toBe("skipped_changed");
    expect(posts()).toBe(1);
  });

  test("a failed save is reported, not retried", async () => {
    const [conversation] = readClaudeExport(Buffer.from(JSON.stringify([chat()])));
    if (!conversation) throw new Error("missing");
    let posts = 0;
    const engine: ClaudeImportEngine = {
      prepare: async () => undefined,
      request: async (method, path) => {
        if (path === "/api/location") return { status: 200, body: { project: { id: "project" } } };
        if (method === "POST") { posts += 1; throw new Error("socket closed"); }
        return { status: 404, body: undefined };
      },
    };
    expect((await importConversations(engine, [conversation], "/work"))[0]?.status).toBe("failed");
    expect(posts).toBe(1);
  });
});
