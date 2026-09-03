import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  COWORKER_TOOLS_MCP_NAME,
  createCoworkerToolsServer,
  createToolHandlers,
  documentCard,
  handleMcpMessage,
  toolCatalog,
} from "./coworker-tools.mjs";

const SLUG = "nova";
const TOKEN = "nova-token";

async function home() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coworker-tools-"));
  await mkdir(path.join(dir, SLUG, "memory"), { recursive: true });
  await writeFile(path.join(dir, SLUG, "coworker.md"), "---\nname: Nova\n---\n", "utf8");
  return dir;
}

async function startServer(coworkersDir, onChange) {
  const handlers = createToolHandlers({ coworkersDir, onChange });
  const server = await createCoworkerToolsServer({
    resolveSlug: (token) => (token === TOKEN ? SLUG : null),
    handlers,
    version: "1.2.3",
  });
  return server;
}

async function rpc(server, message, token = TOKEN) {
  const response = await fetch(server.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, contentType: response.headers.get("content-type") ?? "" };
}

async function call(server, name, args) {
  const reply = await rpc(server, { jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method: "tools/call", params: { name, arguments: args } });
  assert.equal(reply.status, 200);
  return reply.body.result;
}

test("the tool catalog describes every document tool with a strict schema", () => {
  const names = toolCatalog().map((tool) => tool.name);
  assert.deepEqual(names, ["documents_list", "document_create", "document_update", "document_read", "context_set", "document_archive"]);
  for (const tool of toolCatalog()) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 20);
  }
  assert.equal(COWORKER_TOOLS_MCP_NAME, "coworker");
});

test("the MCP handshake answers over plain JSON and notifications are accepted silently", async () => {
  const dir = await home();
  const server = await startServer(dir);
  try {
    const init = await rpc(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    assert.equal(init.status, 200);
    assert.match(init.contentType, /application\/json/);
    assert.equal(init.body.result.protocolVersion, "2025-03-26");
    assert.deepEqual(init.body.result.serverInfo, { name: "open-coworker", version: "1.2.3" });
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    const unknownVersion = await rpc(server, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    assert.equal(unknownVersion.body.result.protocolVersion, "2025-06-18");

    const initialized = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(initialized.status, 202);
    const ping = await rpc(server, { jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual(ping.body, { jsonrpc: "2.0", id: 3, result: {} });
    const list = await rpc(server, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    assert.equal(list.body.result.tools.length, 6);
    const missing = await rpc(server, { jsonrpc: "2.0", id: 5, method: "resources/list" });
    assert.equal(missing.body.error.code, -32601);
    const batch = await rpc(server, [{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", method: "notifications/progress" }]);
    assert.deepEqual(batch.body, [{ jsonrpc: "2.0", id: 6, result: {} }]);

    // A standalone stream is not offered; the client treats 405 as such.
    const get = await fetch(server.url, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(get.status, 405);
    const del = await fetch(server.url, { method: "DELETE", headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(del.status, 200);
    const elsewhere = await fetch(`${server.url.replace(/\/mcp$/, "")}/other`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(elsewhere.status, 404);
    const malformed = await fetch(server.url, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: "{not json" });
    assert.equal(malformed.status, 400);
    assert.equal(server.mcpConfig("abc").headers.Authorization, "Bearer abc");
    assert.equal(server.mcpConfig("abc").url, server.url);
    assert.equal(server.mcpConfig("abc").type, "remote");
  } finally {
    await server.stop();
  }
});

test("only a known coworker token gets in", async () => {
  const dir = await home();
  const server = await startServer(dir);
  try {
    const wrong = await rpc(server, { jsonrpc: "2.0", id: 1, method: "ping" }, "someone-else");
    assert.equal(wrong.status, 401);
    const none = await fetch(server.url, { method: "POST", body: "{}" });
    assert.equal(none.status, 401);
  } finally {
    await server.stop();
  }
});

test("the document tools create, update by section, list, read, set context, and archive with plain summaries and card fields", async () => {
  const dir = await home();
  const changes = [];
  const server = await startServer(dir, (slug, kind) => changes.push(`${slug}:${kind}`));
  try {
    const created = await call(server, "document_create", {
      title: "Launch plan",
      summary: "Ship onboarding by the end of Q3.",
      highlights: ["Three phases", "Two owners", "Vendor risk", "Budget fixed", "Sixth is dropped from the card"],
      body: "## Timeline\n\nWeek one.\n\n## Owners\n\nAna and Ben.\n",
    });
    assert.equal(created.isError, false);
    assert.match(created.content[0].text, /^Wrote "Launch plan" \(id launch-plan, revision 1\)\. 1 active document\./);
    assert.deepEqual(created.structuredContent.document, {
      id: "launch-plan",
      title: "Launch plan",
      summary: "Ship onboarding by the end of Q3.",
      highlights: ["Three phases", "Two owners", "Vendor risk"],
      status: "active",
      revision: 1,
      updatedAt: created.structuredContent.document.updatedAt,
      action: "created",
    });
    assert.ok(created.structuredContent.document.updatedAt > 0);

    const updated = await call(server, "document_update", {
      id: "launch-plan",
      summary: "Ship onboarding by mid-Q3.",
      patch: { heading: "Timeline", content: "Week one and two." },
    });
    assert.equal(updated.isError, false);
    assert.match(updated.content[0].text, /^Updated "Launch plan" to revision 2 — replaced the "Timeline" section\. Sections now: Timeline, Owners\./);
    assert.equal(updated.structuredContent.document.action, "updated");
    assert.equal(updated.structuredContent.document.section, "Timeline");
    assert.equal(updated.structuredContent.document.revision, 2);

    const unchanged = await call(server, "document_update", { id: "launch-plan", patch: { heading: "Timeline", content: "Week one and two." } });
    assert.match(unchanged.content[0].text, /already says that/);
    assert.equal(unchanged.structuredContent.document.action, "unchanged");

    const empty = await call(server, "document_update", { id: "launch-plan" });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /Send a new body/);

    await call(server, "document_create", { title: "Old vendor notes", summary: "Notes from the first vendor round.", body: "Old." });
    const context = await call(server, "context_set", { active: ["launch-plan"], aside: ["old-vendor-notes", "nothing-here"] });
    assert.equal(context.content[0].text, "Put aside: Old vendor notes. No document has the id nothing-here. 1 active document.");
    assert.deepEqual(context.structuredContent.changed, [{ id: "old-vendor-notes", title: "Old vendor notes", status: "aside" }]);

    const listed = await call(server, "documents_list", {});
    assert.match(listed.content[0].text, /^Active \(1\):\n- launch-plan — Launch plan — Ship onboarding by mid-Q3\. \(revision 2\)\n {4}• Three phases/);
    assert.match(listed.content[0].text, /Put aside \(1\):\n- old-vendor-notes/);
    assert.equal(listed.structuredContent.documents.length, 2);

    const read = await call(server, "document_read", { id: "launch-plan" });
    assert.match(read.content[0].text, /^# Launch plan\nid: launch-plan · status: active · revision 2 · last updated by the coworker\nSummary: Ship onboarding by mid-Q3\.\nHighlights:\n- Three phases/);
    assert.match(read.content[0].text, /## Timeline\n\nWeek one and two\./);

    const missing = await call(server, "document_read", { id: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /no document with the id "nope"/);

    const secret = await call(server, "document_create", { title: "Creds", summary: "x", body: "AKIAABCDEFGHIJKLMNOP" });
    assert.equal(secret.isError, true);
    assert.match(secret.content[0].text, /AWS access key/);

    const archived = await call(server, "document_archive", { id: "old-vendor-notes", reason: "The person asked." });
    assert.match(archived.content[0].text, /^Archived "Old vendor notes"/);
    assert.equal(archived.structuredContent.document.status, "archived");

    const unknownTool = await rpc(server, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
    assert.equal(unknownTool.body.error.code, -32602);

    assert.deepEqual(changes, ["nova:created", "nova:updated", "nova:created", "nova:context", "nova:archived"]);
    const index = await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8");
    assert.ok(index.includes("- launch-plan — Launch plan — Ship onboarding by mid-Q3."), index);
    assert.ok(!index.includes("old-vendor-notes"), index);
    // Writing a document clears any pending long-reply reminder.
    assert.ok(!index.includes("## Reminder"));
  } finally {
    await server.stop();
  }
});

test("documentCard keeps three highlights and the handler contract survives a direct message", async () => {
  const card = documentCard({ id: "a", title: "A", summary: "S", highlights: ["1", "2", "3", "4"], status: "active", revision: 2, updatedAt: 9 });
  assert.deepEqual(card, { id: "a", title: "A", summary: "S", highlights: ["1", "2", "3"], status: "active", revision: 2, updatedAt: 9 });
  const invalid = await handleMcpMessage({ id: 1, method: "ping" }, { slug: SLUG, handlers: {}, tools: [], serverInfo: {} });
  assert.equal(invalid.error.code, -32600);
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { slug: SLUG, handlers: {}, tools: [], serverInfo: {} }), null);
});
