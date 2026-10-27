import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { renderOpencodeV2Config } from "../src/managed-opencode-v2.js";
import { createV2ContextBridge } from "../src/opencode-v2-context-bridge.js";
import contextPlugin from "../src/opencode-plugins/openwork-context-v2.js";

type Answer = { effect: "ask" | "allow" | "deny"; reply?: "once" | "always" | "reject" };

/** The engine's permission and event routes, with the person answering each prompt. */
async function fakeEngine(answer: Answer) {
  const asked: Array<{ query: string; body: Record<string, unknown> }> = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Basic ${Buffer.from("opencode:secret").toString("base64")}`) return void response.writeHead(401).end();
    if (request.method === "GET" && url.pathname === "/api/event") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    let text = "";
    request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      asked.push({ query: url.search, body: JSON.parse(text) });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "per_one", effect: answer.effect } }));
      if (answer.reply) setTimeout(() => {
        for (const stream of streams) stream.write(`data: ${JSON.stringify({ type: "permission.replied", data: { sessionID: "ses_one", requestID: "per_one", reply: answer.reply } })}\n\n`);
      }, 20);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    asked, connection: { url: `http://127.0.0.1:${port}`, username: "opencode", password: "secret" },
    close: () => { for (const stream of streams) stream.end(); return new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function uploadThroughBridge(answer: Answer, caller: Record<string, unknown> | null = { directory: "/work/acme", messageId: "msg_one", callId: "call_one", agent: "build" }) {
  const engine = await fakeEngine(answer);
  const uploads: unknown[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    assert.equal(path, "/experimental/extensions/call");
    uploads.push(JSON.parse(String(init?.body)));
    return { ok: true, fileId: "drive-file-1" };
  }, () => engine.connection);
  try {
    const response = await fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_drive_upload", input: { path: "proposal.docx", folderId: "folder-1" }, sessionId: "ses_one", ...(caller ? { caller } : {}) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown>, uploads, asked: engine.asked };
  } finally {
    await bridge.close();
    await engine.close();
  }
}

test("a v2 Drive upload runs only after the person allows that file in the calling chat", async () => {
  const result = await uploadThroughBridge({ effect: "ask", reply: "once" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.asked, [{
    query: `?location[directory]=${encodeURIComponent("/work/acme")}`,
    body: {
      action: "drive_upload_file", resources: ["proposal.docx"], save: [], agent: "build",
      metadata: { path: "proposal.docx", target: "Google Drive folder folder-1" },
      source: { type: "tool", messageID: "msg_one", id: "call_one" },
    },
  }]);
  assert.deepEqual(result.uploads, [{
    extensionId: "openwork-cloud-uploads", action: "drive_upload_file", args: { path: "proposal.docx", folderId: "folder-1" }, context: {},
  }]);
});

test("a declined, pre-allowed, blocked or unaskable v2 Drive upload sends nothing", async () => {
  for (const [answer, message] of [
    [{ effect: "ask", reply: "reject" }, /declined/],
    [{ effect: "allow" }, /not shown to you for approval/],
    [{ effect: "deny" }, /do not allow this upload/],
  ] as const) {
    const result = await uploadThroughBridge(answer);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), message);
    assert.deepEqual(result.uploads, []);
  }
  const unaskable = await uploadThroughBridge({ effect: "ask", reply: "once" }, null);
  assert.equal(unaskable.status, 400);
  assert.match(String(unaskable.body.error), /cannot ask for your approval/);
  assert.deepEqual([unaskable.asked, unaskable.uploads], [[], []]);
});

test("the engine asks before every context-tool Drive write and Gmail draft instead of allowing it by default", () => {
  const rendered = renderOpencodeV2Config({ providers: [], skills: [], contextPluginDirectory: "/plugins/context", contextTools: { url: "http://127.0.0.1:1/read", token: "t" } });
  assert.deepEqual(rendered.permissions, ["drive_upload_file", "drive_pull_file", "drive_push_file", "gmail_create_draft_with_attachments"].map(action => ({ action, resource: "*", effect: "ask" })));
  assert.equal(renderOpencodeV2Config({ providers: [], skills: [] }).permissions, undefined);
});

/** Sends one Drive file tool call to the bridge, as the v2 context plugin does. */
async function driveFileThroughBridge(name: string, input: Record<string, unknown>, answer: Answer, caller: Record<string, unknown> | null = { directory: "/work/acme", messageId: "msg_one", callId: "call_one", agent: "build" }) {
  const engine = await fakeEngine(answer);
  const calls: unknown[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    assert.equal(path, "/experimental/drive-files/call");
    calls.push(JSON.parse(String(init?.body)));
    return { ok: true, path: "drive/notes.docx" };
  }, () => engine.connection);
  try {
    const response = await fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, input, sessionId: "ses_one", ...(caller ? { caller } : {}) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown>, calls, asked: engine.asked };
  } finally {
    await bridge.close();
    await engine.close();
  }
}

test("the v2 context plugin's Drive push reaches the host only after the person allows it in the calling chat", async () => {
  const engine = await fakeEngine({ effect: "ask", reply: "once" });
  const calls: unknown[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    if (path !== "/experimental/drive-files/call") return { skills: [] };
    calls.push(JSON.parse(String(init?.body)));
    return { ok: true, path: "drive/notes.docx", saved: true };
  }, () => engine.connection);
  type Added = { name: string; input: Record<string, unknown>; execute(input: unknown, call: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> };
  const tools = new Map<string, Added>();
  const registration = { dispose: async () => {} };
  const stop = await contextPlugin.setup({
    location: { directory: "/work/acme" }, options: { url: bridge.url, token: bridge.token },
    tool: { transform: async (add: (editor: { add(tool: Added): void }) => void) => { add({ add: tool => tools.set(tool.name, tool) }); return registration; } },
    skill: { transform: async () => registration, reload: async () => {} },
  } as never);
  try {
    assert.deepEqual(["drive_pull_file", "drive_file_status", "drive_push_file"].filter(name => tools.has(name)), ["drive_pull_file", "drive_file_status", "drive_push_file"]);
    const push = tools.get("drive_push_file")!;
    assert.deepEqual([push.input.required, push.input.additionalProperties], [["path"], false]);
    const result = await push.execute({ path: "drive/notes.docx" }, { signal: AbortSignal.timeout(10_000), sessionID: "ses_one", messageID: "msg_one", id: "call_one", agent: "build" });
    assert.deepEqual(JSON.parse(result.content[0]!.text), { ok: true, path: "drive/notes.docx", saved: true });
    assert.deepEqual(engine.asked.map(request => request.body), [{
      action: "drive_push_file", resources: ["drive/notes.docx"], save: [], agent: "build",
      metadata: { path: "drive/notes.docx", mode: "default" }, source: { type: "tool", messageID: "msg_one", id: "call_one" },
    }]);
    assert.deepEqual(calls, [{ action: "drive_push_file", args: { path: "drive/notes.docx" }, context: { sessionId: "ses_one", directory: "/work/acme", messageId: "msg_one" } }]);
  } finally {
    await stop();
    await bridge.close();
    await engine.close();
  }
});

test("a v2 Drive pull or status check runs in the calling chat's workspace without asking", async () => {
  const pull = await driveFileThroughBridge("drive_pull_file", { fileId: "file-1" }, { effect: "deny" });
  const status = await driveFileThroughBridge("drive_file_status", {}, { effect: "deny" });
  assert.deepEqual([pull.status, status.status], [200, 200]);
  assert.deepEqual([pull.asked, status.asked], [[], []]);
  assert.deepEqual([...pull.calls, ...status.calls], [
    { action: "drive_pull_file", args: { fileId: "file-1" }, context: { sessionId: "ses_one", directory: "/work/acme", messageId: "msg_one" } },
    { action: "drive_file_status", args: {}, context: { sessionId: "ses_one", directory: "/work/acme", messageId: "msg_one" } },
  ]);
});

test("a declined, pre-allowed, blocked, unaskable or malformed v2 Drive push or overwriting pull changes nothing", async () => {
  for (const [name, input, answer, caller, message] of [
    ["drive_push_file", { path: "notes.docx" }, { effect: "ask", reply: "reject" }, undefined, /^You declined saving this file, so nothing was uploaded\.$/],
    ["drive_push_file", { path: "notes.docx" }, { effect: "allow" }, undefined, /^Saving this file was not shown to you for approval/],
    ["drive_push_file", { path: "notes.docx" }, { effect: "deny" }, undefined, /^Your permissions do not allow saving this file/],
    ["drive_push_file", { path: "notes.docx" }, { effect: "ask", reply: "once" }, null, /cannot ask for your approval, so nothing was uploaded/],
    ["drive_push_file", { path: "notes.docx", overwriteDriveChanges: true }, { effect: "ask", reply: "once" }, undefined, /overwriteDriveChanges/],
    ["drive_pull_file", { fileId: "file-1", path: "notes.docx", overwrite: true }, { effect: "ask", reply: "reject" }, undefined, /^You declined replacing this local copy, so nothing was changed\.$/],
  ] as const) {
    const result = await driveFileThroughBridge(name, input, answer, caller);
    assert.equal(result.status, 400, name);
    assert.match(String(result.body.error), message);
    assert.deepEqual(result.calls, []);
  }
});

async function gmailDraftThroughBridge(answer: Answer, caller: Record<string, unknown> | null = { directory: "/work/acme", messageId: "msg_one", callId: "call_one", agent: "build" }) {
  const engine = await fakeEngine(answer);
  const drafts: unknown[] = [];
  const bridge = await createV2ContextBridge(async (path, init) => {
    assert.equal(path, "/experimental/extensions/call");
    drafts.push(JSON.parse(String(init?.body)));
    return { ok: true, draftId: "draft-1" };
  }, () => engine.connection);
  try {
    const response = await fetch(bridge.url, {
      method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openwork_gmail_draft", input: { to: "blair@example.test", subject: "Proposal", body: "Attached.", paths: ["proposal.docx"], connectionId: "google-workspace" }, sessionId: "ses_one", ...(caller ? { caller } : {}) }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown>, drafts, asked: engine.asked };
  } finally {
    await bridge.close();
    await engine.close();
  }
}

test("a v2 Gmail draft with attachments is created only after the person allows it in the calling chat", async () => {
  const result = await gmailDraftThroughBridge({ effect: "ask", reply: "once" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.asked.map(request => request.body), [{
    action: "gmail_create_draft_with_attachments", resources: ["proposal.docx"], save: [], agent: "build",
    metadata: { paths: ["proposal.docx"], subject: "Proposal", target: "Gmail draft to blair@example.test", connectionId: "google-workspace" },
    source: { type: "tool", messageID: "msg_one", id: "call_one" },
  }]);
  assert.deepEqual(result.drafts, [{
    extensionId: "openwork-cloud-uploads", action: "gmail_create_draft_with_attachments",
    args: { to: "blair@example.test", subject: "Proposal", body: "Attached.", paths: ["proposal.docx"], connectionId: "google-workspace" }, context: { directory: "/work/acme" },
  }]);
});

test("a declined, pre-allowed, blocked or unaskable v2 Gmail draft creates nothing", async () => {
  for (const [answer, message] of [
    [{ effect: "ask", reply: "reject" }, /^You declined this draft, so no draft was created\.$/],
    [{ effect: "allow" }, /not shown to you for approval/],
    [{ effect: "deny" }, /do not allow this draft/],
  ] as const) {
    const result = await gmailDraftThroughBridge(answer);
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), message);
    assert.deepEqual(result.drafts, []);
  }
  const unaskable = await gmailDraftThroughBridge({ effect: "ask", reply: "once" }, null);
  assert.match(String(unaskable.body.error), /cannot ask for your approval, so no draft was created/);
  assert.deepEqual([unaskable.asked, unaskable.drafts], [[], []]);
});
