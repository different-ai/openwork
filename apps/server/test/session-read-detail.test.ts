import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fitSessionReadBudget,
  richV1Message,
  richV2Message,
  SESSION_READ_LIST_LIMITS,
  SESSION_READ_MESSAGE_LIMITS,
  type RichMessage,
} from "../src/opencode-plugins/session-read-detail.js";
import { readV2NativeMessages } from "../src/opencode-v2-read-adapter.js";

// Rows follow OpenCode v2.2.0 `Session.Message.Info` (GET /api/session/:id/message).
const model = { id: "claude-opus", providerID: "anthropic", variant: "high" };
const error = { type: "ProviderError", message: "overloaded", status: 529, retryAfterMs: 2000, response: { body: "secret provider body" } };

const assistant = {
  id: "msg_a", type: "assistant", time: { created: 2, streamed: 3, completed: 9 }, agent: "build", model,
  native: { signature: "opaque" },
  content: [
    { type: "reasoning", text: "thinking it over", time: { created: 3, completed: 4 }, native: { signature: "sig" } },
    { type: "text", text: "Running the tests." },
    { type: "tool", id: "call_1", name: "shell", executed: true, time: { created: 4, ran: 5, completed: 6 },
      state: { status: "completed", input: { command: "pnpm test" }, metadata: { exit: 0 },
        content: [{ type: "text", text: "12 passed" }, { type: "file", uri: "file:///tmp/report.html", mime: "text/html", name: "report.html" }] } },
    { type: "tool", id: "call_2", name: "read", time: { created: 6, ran: 6, completed: 7 },
      state: { status: "error", input: { path: "missing.ts" }, error: { type: "ToolError", message: "ENOENT" } } },
    { type: "tool", id: "call_3", name: "subagent", time: { created: 7, ran: 7 },
      state: { status: "running", input: { agent: "explore", prompt: "look around" }, metadata: { sessionId: "ses_child" } } },
    { type: "tool", id: "call_4", name: "edit", time: { created: 8 }, state: { status: "streaming", input: "{\"path\":\"a." } },
  ],
  snapshot: { start: "snap1", end: "snap2", files: ["src/a.ts"] },
  finish: "tool-calls", cost: 0.0123, tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } },
  retry: { attempt: 1, at: 2, error },
};

test("maps every v2 assistant field and content item, without native blobs or provider bodies", () => {
  const rich = richV2Message(assistant, SESSION_READ_LIST_LIMITS);
  assert.deepEqual(rich, {
    id: "msg_a", type: "assistant", time: { created: 2, streamed: 3, completed: 9 }, agent: "build",
    model: { providerId: "anthropic", modelId: "claude-opus", variant: "high" },
    finish: "tool-calls", cost: 0.0123, tokens: { input: 100, output: 50, reasoning: 20, cache: { read: 10, write: 5 } },
    retry: { attempt: 1, at: 2, error: { type: "ProviderError", message: "overloaded", status: 529, retryAfterMs: 2000 } },
    changedFiles: ["src/a.ts"],
    content: [
      { type: "reasoning", text: "thinking it over", time: { created: 3, completed: 4 } },
      { type: "text", text: "Running the tests." },
      { type: "tool", id: "call_1", name: "shell", status: "completed", executed: true, input: { command: "pnpm test" },
        output: "12 passed", files: [{ name: "report.html", mime: "text/html", uri: "file:///tmp/report.html" }],
        metadata: { exit: 0 }, time: { created: 4, ran: 5, completed: 6 } },
      { type: "tool", id: "call_2", name: "read", status: "error", input: { path: "missing.ts" },
        error: { type: "ToolError", message: "ENOENT" }, time: { created: 6, ran: 6, completed: 7 } },
      { type: "tool", id: "call_3", name: "subagent", status: "running", input: { agent: "explore", prompt: "look around" },
        metadata: { sessionId: "ses_child" }, childSessionId: "ses_child", time: { created: 7, ran: 7 } },
      { type: "tool", id: "call_4", name: "edit", status: "streaming", input: "{\"path\":\"a.", time: { created: 8 } },
    ],
  });
  const encoded = JSON.stringify(rich);
  assert.ok(!encoded.includes("opaque") && !encoded.includes("\"sig\"") && !encoded.includes("secret provider body"));
});

test("maps every other v2 message type", () => {
  const rows = [
    { id: "m1", type: "user", time: { created: 1 }, text: "Fix it @explore",
      files: [{ data: "aGVsbG8=", mime: "image/png", source: { type: "inline" }, name: "shot.png" },
        { data: "", mime: "text/plain", source: { type: "uri", uri: "file:///a.txt" }, name: "a.txt" }],
      agents: [{ name: "explore", mention: { start: 7, end: 15, text: "@explore" } }],
      skills: [{ id: "skl_1", name: "release", text: "skill body" }] },
    { id: "m2", type: "synthetic", time: { created: 2 }, text: "hidden context" },
    { id: "m3", type: "system", time: { created: 3 }, text: "system note" },
    { id: "m4", type: "skill", time: { created: 4 }, skill: "skl_1", name: "release", text: "skill body" },
    { id: "m5", type: "shell", time: { created: 5, completed: 6 }, shellID: "sh_1", command: "ls", status: "exited", exit: 0,
      output: { output: "a\nb", cursor: 3, size: 3, truncated: false } },
    { id: "m6", type: "compaction", time: { created: 7 }, status: "completed", reason: "auto", summary: "so far", model, cost: 0.5,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, native: { x: 1 } },
    { id: "m7", type: "idle", time: { created: 8 }, outcome: "failed", error },
    { id: "m8", type: "agent-switched", time: { created: 9 }, agent: "plan", previous: "build" },
    { id: "m9", type: "model-switched", time: { created: 10 }, model, previous: { id: "gpt", providerID: "openai" } },
    { id: "m10", type: "location-switched", time: { created: 11 }, location: { directory: "/b" }, subpath: "pkg",
      previous: { location: { directory: "/a" } } },
    { id: "m11", type: "something-new", time: { created: 12 }, whatever: true },
  ];
  assert.deepEqual(rows.map((row) => richV2Message(row, SESSION_READ_LIST_LIMITS)), [
    { id: "m1", type: "user", time: { created: 1 }, text: "Fix it @explore",
      files: [{ name: "shot.png", mime: "image/png", inline: true }, { name: "a.txt", mime: "text/plain", uri: "file:///a.txt" }],
      agents: ["explore"], skills: [{ id: "skl_1", name: "release" }] },
    { id: "m2", type: "synthetic", time: { created: 2 }, text: "hidden context" },
    { id: "m3", type: "system", time: { created: 3 }, text: "system note" },
    { id: "m4", type: "skill", time: { created: 4 }, skill: "skl_1", name: "release", text: "skill body" },
    { id: "m5", type: "shell", time: { created: 5, completed: 6 }, shellId: "sh_1", command: "ls", status: "exited", exit: 0, output: "a\nb" },
    { id: "m6", type: "compaction", time: { created: 7 }, status: "completed", reason: "auto", summary: "so far",
      model: { providerId: "anthropic", modelId: "claude-opus", variant: "high" }, cost: 0.5,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
    { id: "m7", type: "idle", time: { created: 8 }, outcome: "failed",
      error: { type: "ProviderError", message: "overloaded", status: 529, retryAfterMs: 2000 } },
    { id: "m8", type: "agent-switched", time: { created: 9 }, agent: "plan", previous: "build" },
    { id: "m9", type: "model-switched", time: { created: 10 }, model: { providerId: "anthropic", modelId: "claude-opus", variant: "high" },
      previous: { providerId: "openai", modelId: "gpt" } },
    { id: "m10", type: "location-switched", time: { created: 11 }, directory: "/b", subpath: "pkg", previousDirectory: "/a" },
    { id: "m11", type: "something-new", time: { created: 12 } },
  ]);
  assert.ok(!JSON.stringify(richV2Message(rows[0], SESSION_READ_LIST_LIMITS)).includes("aGVsbG8="), "inline file data is not returned");
});

test("long fields are clipped with a marker; a messageId read keeps far more", () => {
  const long = "x".repeat(10_000);
  const row = { ...assistant, content: [{ type: "text", text: long },
    { type: "tool", id: "c", name: "shell", time: { created: 1 }, state: { status: "completed", input: { blob: long }, content: [{ type: "text", text: long }] } }] };
  const listed = richV2Message(row, SESSION_READ_LIST_LIMITS);
  assert.equal(listed?.truncated, true);
  const content = Array.isArray(listed?.content) ? listed.content : [];
  assert.match(String(content[0]?.text), /^x{8000}…\[\+2000 chars; read this message by messageId for more\]$/);
  assert.equal(typeof content[1]?.input, "string", "oversized input becomes a clipped JSON string");
  assert.match(String(content[1]?.input), /^\{"blob":"x+…\[\+\d+ chars/);
  assert.match(String(content[1]?.output), /^x{4000}…/);
  const full = richV2Message(row, SESSION_READ_MESSAGE_LIMITS, { includeMetadata: true });
  assert.equal(full?.truncated, undefined);
  const fullContent = Array.isArray(full?.content) ? full.content : [];
  assert.equal(fullContent[0]?.text, long);
  assert.deepEqual(fullContent[1]?.input, { blob: long });
});

test("past a message's tool budget, calls are still listed by name without their detail", () => {
  const big = "y".repeat(3_900);
  const content = Array.from({ length: 40 }, (_, index) => ({ type: "tool", id: `c${index}`, name: "read", time: { created: index },
    state: { status: "completed", input: { path: `f${index}` }, content: [{ type: "text", text: big }] } }));
  const rich = richV2Message({ ...assistant, content }, SESSION_READ_LIST_LIMITS);
  const calls = Array.isArray(rich?.content) ? rich.content : [];
  assert.equal(calls.length, 40);
  assert.equal(rich?.truncated, true);
  assert.equal(calls[0]?.output, big);
  const last = calls[39];
  assert.deepEqual([last?.id, last?.name, last?.status, last?.output, last?.detailOmitted], ["c39", "read", "completed", undefined, true]);
});

test("the result budget keeps the newest (end) or oldest (start) messages, and always one", () => {
  const messages: RichMessage[] = Array.from({ length: 5 }, (_, index) => ({ id: `m${index}`, type: "user", time: {}, text: "z".repeat(100) }));
  const end = fitSessionReadBudget(messages, "end", 300);
  assert.deepEqual(end.messages.map((message) => message.id), ["m3", "m4"]);
  assert.equal(end.omittedForSize, 3);
  assert.deepEqual(fitSessionReadBudget(messages, "start", 300).messages.map((message) => message.id), ["m0", "m1"]);
  assert.equal(fitSessionReadBudget(messages, "end", 1).messages.length, 1);
});

test("v1 messages map into the same shape", () => {
  const user = { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [
    { type: "text", text: "Hello" }, { type: "text", text: "ignored", ignored: true },
    { type: "file", mime: "image/png", filename: "a.png", url: "data:image/png;base64,AAA" }, { type: "agent", name: "explore" }] };
  const reply = { info: { id: "a1", role: "assistant", time: { created: 2, completed: 5 }, modelID: "gpt", providerID: "openai", mode: "build",
    cost: 0.1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
    error: { name: "APIError", data: { message: "rate limited", statusCode: 429 } } }, parts: [
    { type: "step-start" }, { type: "reasoning", text: "hmm", time: { start: 2, end: 3 } }, { type: "text", text: "Done", synthetic: true },
    { type: "tool", callID: "call_1", tool: "task", state: { status: "completed", input: { prompt: "p" }, output: "ok", title: "Task",
      metadata: { sessionId: "ses_kid" }, time: { start: 3, end: 4 } } },
    { type: "tool", callID: "call_2", tool: "bash", state: { status: "error", input: { command: "x" }, error: "boom", time: { start: 4, end: 5 } } },
    { type: "patch", hash: "h", files: ["b.ts"] }, { type: "step-finish", tokens: {}, cost: 0 }] };
  assert.deepEqual(richV1Message(user, SESSION_READ_LIST_LIMITS), {
    id: "u1", type: "user", time: { created: 1 }, text: "Hello",
    files: [{ name: "a.png", mime: "image/png", inline: true }], agents: ["explore"] });
  assert.deepEqual(richV1Message(reply, SESSION_READ_LIST_LIMITS), {
    id: "a1", type: "assistant", time: { created: 2, completed: 5 }, agent: "build", model: { providerId: "openai", modelId: "gpt" },
    finish: "stop", cost: 0.1, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    error: { type: "APIError", message: "rate limited", status: 429 }, changedFiles: ["b.ts"],
    content: [
      { type: "reasoning", text: "hmm", time: { created: 2, completed: 3 } },
      { type: "text", text: "Done", synthetic: true },
      { type: "tool", id: "call_1", name: "task", status: "completed", input: { prompt: "p" }, output: "ok",
        metadata: { sessionId: "ses_kid" }, childSessionId: "ses_kid", time: { ran: 3, completed: 4 } },
      { type: "tool", id: "call_2", name: "bash", status: "error", input: { command: "x" },
        error: { type: "ToolError", message: "boom" }, time: { ran: 4, completed: 5 } },
    ] });
});

test("native reads page every message type from the end or the start, in timeline order", async () => {
  const history = Array.from({ length: 250 }, (_, index) => ({ id: `m${index}`, type: index % 3 ? "assistant" : "idle", time: { created: index } }));
  const requests: URL[] = [];
  const read = async (path: string) => {
    const url = new URL(path, "http://engine");
    requests.push(url);
    assert.equal(url.pathname, "/workspace/ws%201/opencode2/api/session/ses_1/message");
    const limit = Number(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor");
    const [order, offset] = cursor ? cursor.split(":") : [url.searchParams.get("order"), "0"];
    const ordered = order === "desc" ? [...history].reverse() : history;
    const start = Number(offset);
    const data = ordered.slice(start, start + limit);
    return { data, cursor: { next: start + data.length < history.length ? `${order}:${start + data.length}` : undefined } };
  };
  const end = await readV2NativeMessages(read, "ws 1", "ses_1", { from: "end", limit: 220 });
  assert.deepEqual(end.map((row) => row.id), history.slice(30).map((row) => row.id));
  const start = await readV2NativeMessages(read, "ws 1", "ses_1", { from: "start", limit: 5 });
  assert.deepEqual(start.map((row) => row.id), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(requests.at(-1)?.searchParams.get("order"), "asc");
  const all = await readV2NativeMessages(read, "ws 1", "ses_1", { from: "start" });
  assert.equal(all.length, 250);
});
