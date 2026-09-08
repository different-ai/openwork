import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createCoworkerToolsServer,
  createToolHandlers,
} from "./coworker-tools.mjs";

const SLUG = "nova";
const TOKEN = "nova-token";

async function home(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coworker-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
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

test("the MCP handshake answers over plain JSON and notifications are accepted silently", async (t) => {
  const dir = await home(t);
  const server = await startServer(dir);
  try {
    const init = await rpc(server, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    assert.equal(init.status, 200);
    assert.match(init.contentType, /application\/json/);
    assert.equal(init.body.result.protocolVersion, "2025-03-26");
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
    const invalid = await rpc(server, { id: 7, method: "ping" });
    assert.equal(invalid.body.error.code, -32600);
  } finally {
    await server.stop();
  }
});

test("only a known coworker token gets in", async (t) => {
  const dir = await home(t);
  const server = await startServer(dir);
  try {
    const wrong = await rpc(server, { jsonrpc: "2.0", id: 1, method: "ping" }, "someone-else");
    assert.equal(wrong.status, 401);
    const none = await fetch(server.url, { method: "POST", body: "{}" });
    assert.equal(none.status, 401);
    for (const authorization of ["Basic " + TOKEN, "Bearer " + " ".repeat(8_000) + "invalid token", "Bearer " + TOKEN + " other"]) {
      const rejected = await fetch(server.url, { method: "POST", headers: { Authorization: authorization }, body: "{}", signal: AbortSignal.timeout(5_000) });
      assert.equal(rejected.status, 401);
    }
    const valid = await fetch(server.url, { method: "POST", headers: { Authorization: `bEaReR\t${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) });
    assert.equal(valid.status, 200);
  } finally {
    await server.stop();
  }
});

test("authenticated document dispatch persists once and rejects invalid actions", async (t) => {
  const dir = await home(t);
  const changes = [];
  const server = await startServer(dir, (slug, kind) => changes.push(`${slug}:${kind}`));
  try {
    const created = await call(server, "document_create", {
      title: "Launch plan",
      summary: "Ship onboarding by the end of Q3.",
      body: "## Timeline\n\nWeek one.\n\n## Owners\n\nAna and Ben.\n",
    });
    assert.equal(created.isError, false);
    assert.equal(created.structuredContent.document.id, "launch-plan");

    const updated = await call(server, "document_update", {
      id: "launch-plan",
      summary: "Ship onboarding by mid-Q3.",
      patch: { heading: "Timeline", content: "Week one and two." },
    });
    assert.equal(updated.isError, false);
    assert.equal(updated.structuredContent.document.revision, 2);

    const unchanged = await call(server, "document_update", { id: "launch-plan", patch: { heading: "Timeline", content: "Week one and two." } });
    assert.equal(unchanged.structuredContent.document.action, "unchanged");

    const empty = await call(server, "document_update", { id: "launch-plan" });
    assert.equal(empty.isError, true);
    assert.match(empty.content[0].text, /Send a new body/);

    const read = await call(server, "document_read", { id: "launch-plan" });
    assert.match(read.content[0].text, /## Timeline\n\nWeek one and two\./);

    const missing = await call(server, "document_read", { id: "nope" });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /no document with the id "nope"/);

    const secret = await call(server, "document_create", { title: "Creds", summary: "x", body: "AKIAABCDEFGHIJKLMNOP" });
    assert.equal(secret.isError, true);
    assert.match(secret.content[0].text, /AWS access key/);

    const unknownTool = await rpc(server, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "delete_everything", arguments: {} } });
    assert.equal(unknownTool.body.error.code, -32602);

    assert.deepEqual(changes, ["nova:created", "nova:updated"]);
    const index = await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8");
    assert.ok(index.includes("- launch-plan — Launch plan — Ship onboarding by mid-Q3."), index);
    // Writing a document clears any pending long-reply reminder.
    assert.ok(!index.includes("## Reminder"));
  } finally {
    await server.stop();
  }
});
