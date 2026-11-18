// Run with pnpm dlx node@22 --test .../workshop-{store,persistence}.test.mjs.
// Node 22's node:sqlite ExperimentalWarning is expected, not a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSnapshotStore } from "./workshop-store.mjs";

const root = "/private/var/folders/8j/hhcc8zs100d3fd654fjkk9580000gn/T/opencode";
const alex = "Alex Chen|alex|CEO";
const priya = "Priya Shah|priya|VP Engineering";
function directory(t) {
  mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, "workshop-persistence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
async function launch(t, service, file, person = alex, expectFailure = false) {
  const child = fork(new URL(`./${service}.mjs`, import.meta.url), [], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: "0", OPEN_WORKPLACE_PERSON: person, OPEN_WORKPLACE_NOW: "2026-10-16T16:00:00Z", ...(file ? { OPEN_WORKPLACE_STATE_FILE: file } : {}) },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes; });
  let stopped = false;
  const stop = async () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return;
    stopped = true; const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  };
  t.after(stop);
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Startup timed out")); }, 15000);
    child.once("message", (message) => { clearTimeout(timer); resolve(message); });
    child.once("exit", (code) => { clearTimeout(timer); if (expectFailure) resolve({ failed: true }); else reject(new Error(`Worker exited ${code}: ${stderr}`)); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  if (expectFailure) { assert.equal(ready.failed, true, "invalid state must exit without ready IPC"); return; }
  assert.equal(ready.type, "ready"); const base = `http://127.0.0.1:${ready.port}`;
  async function request(path, method = "GET", body, binary = false) {
    const response = await fetch(base + path, { method, headers: { authorization: "Bearer open-workplace-token", "content-type": binary ? "application/octet-stream" : "application/json" }, body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });
    const value = binary && method === "GET" ? Buffer.from(await response.arrayBuffer()) : response.status === 204 || response.status === 202 ? null : await response.json();
    return { status: response.status, value };
  }
  async function tool(name, args = {}) {
    const { status, value } = await request("/mcp", "POST", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(status, 200); assert.equal(value.result.isError, false, value.result.content[0].text);
    return JSON.parse(value.result.content[0].text);
  }
  return { stop, request, tool, state: async () => (await request("/state")).value };
}

test("Microsoft REST and MCP mutations, binary uploads, folders, identity and counters survive abrupt restart; reset is isolated", async (t) => {
  const dir = directory(t), file = join(dir, "alex-microsoft.sqlite"), otherFile = join(dir, "priya-microsoft.sqlite");
  let a = await launch(t, "microsoft365", file);
  const b = await launch(t, "microsoft365", otherFile, priya);
  assert.equal((await a.request("/v1.0/me")).value.mail, "alex@acme.test");
  assert.equal((await b.request("/v1.0/me")).value.mail, "priya@acme.test");
  const folder = await a.tool("mail_create_folder", { name: "Durable triage" });
  await a.tool("mail_move", { message_id: "mail-northwind-1", folder_id: folder.id });
  const draft = await a.tool("mail_create_draft", { subject: "Durable message", body: "Saved content", to: ["priya@acme.test"] });
  await a.tool("mail_send", { message_id: draft.id });
  await a.request("/v1.0/me/messages/mail-northwind-2", "PATCH", { isRead: true, categories: ["Durable"] });
  const event = await a.tool("calendar_create", { subject: "Durable event", start: "2026-10-20T10:00:00Z", end: "2026-10-20T11:00:00Z" });
  await a.request(`/v1.0/me/events/${event.id}`, "PATCH", { subject: "Rescheduled durable event" });
  const driveFolder = await a.tool("file_create_folder", { name: "Durable files" });
  const bytes = Buffer.from([0, 255, 128, 13, 10, 1, 2, 3]);
  const binary = (await a.request("/v1.0/me/drive/root:/Durable%20files/payload.bin:/content", "PUT", bytes, true)).value;
  await a.tool("file_write", { path: "mcp-binary.bin", content_base64: bytes.toString("base64") });
  const upload = await a.tool("file_create_upload_session", { path: "session-binary.bin" });
  const uploadPath = new URL(upload.uploadUrl).pathname;
  assert.equal((await a.request(uploadPath, "PUT", bytes, true)).status, 201);
  // Unfinished upload sessions are state too, not only their completed file content.
  const pending = await a.tool("file_create_upload_session", { path: "pending.bin" });
  const other = await b.tool("mail_create_draft", { subject: "Other participant only", body: "Private fictional data", to: ["alex@acme.test"] });
  const before = await a.state(); await a.stop();
  a = await launch(t, "microsoft365", file);
  assert.deepEqual(await a.state(), before);
  assert.deepEqual((await a.request(`/v1.0/me/drive/items/${binary.id}/content`, "GET", undefined, true)).value, bytes);
  assert.deepEqual(Buffer.from((await a.tool("file_read", { item_id: binary.id })).content_base64, "base64"), bytes);
  assert.equal((await a.tool("calendar_read", { event_id: event.id })).subject, "Rescheduled durable event");
  assert.equal((await a.tool("mail_read", { message_id: draft.id })).parentFolderId, "sentitems");
  assert.equal((await a.request(new URL(pending.uploadUrl).pathname, "PUT", bytes, true)).status, 201);
  assert.equal(before.files.find((entry) => entry.id === driveFolder.id).folder.childCount, 1);
  const later = await a.tool("mail_create_draft", { subject: "Next counter", body: "Next", to: [] });
  assert.notEqual(later.id, draft.id);
  assert.equal((await a.state()).audit.at(-1).sequence > before.audit.at(-1).sequence, true);
  assert.equal((await b.state()).messages.some((message) => message.subject === "Durable message"), false);
  await a.request("/reset", "POST", {}); await a.stop();
  a = await launch(t, "microsoft365", file);
  assert.equal((await a.state()).messages.some((message) => message.subject === "Durable message"), false);
  assert.equal((await b.tool("mail_read", { message_id: other.id })).subject, "Other participant only");
  await b.stop(); const reopenedB = await launch(t, "microsoft365", otherFile, priya);
  assert.equal((await reopenedB.tool("mail_read", { message_id: other.id })).subject, "Other participant only");
});

test("Jira/Confluence REST and MCP retain comments, body history, audits and all allocation counters", async (t) => {
  const dir = directory(t), file = join(dir, "alex-atlassian.sqlite"), otherFile = join(dir, "priya-atlassian.sqlite");
  let a = await launch(t, "atlassian", file); const b = await launch(t, "atlassian", otherFile, priya);
  const initial = await a.state(); const issue = initial.jira.issues[0];
  const comment = (await a.request(`/jira/rest/api/2/issue/${issue.key}/comment`, "POST", { body: "Durable Jira comment" })).value;
  await a.request(`/jira/rest/api/2/issue/${issue.key}`, "PUT", { fields: { summary: "Durable Jira summary" } });
  const { metadata: page } = await a.tool("confluence_get_page", { title: "Working at the office", space_key: "HB", convert_to_markdown: false });
  await a.tool("confluence_update_page", { page_id: page.id, title: page.title, content: page.content.value + "<p>Durable page addition</p>", content_format: "storage", version_comment: "Durable version", is_minor_edit: true });
  const confluenceComment = await a.tool("confluence_add_comment", { page_id: page.id, body: "Durable Confluence comment" });
  const other = await b.tool("confluence_add_comment", { page_id: page.id, body: "Other participant only" });
  const before = await a.state(); await a.stop(); a = await launch(t, "atlassian", file);
  assert.deepEqual(await a.state(), before);
  const readIssue = (await a.request(`/jira/rest/api/2/issue/${issue.key}?expand=changelog`)).value;
  assert.equal(readIssue.fields.summary, "Durable Jira summary");
  assert.equal(readIssue.fields.comment.comments.some((item) => item.id === comment.id && item.body === "Durable Jira comment"), true);
  const readPage = (await a.request(`/confluence/rest/api/content/${page.id}?expand=body.storage,version`)).value;
  assert.match(readPage.body.storage.value, /Durable page addition/); assert.equal(readPage.version.message, "Durable version"); assert.equal(readPage.version.minorEdit, true);
  assert.equal((await a.tool("confluence_get_comments", { page_id: page.id })).some((item) => item.id === confluenceComment.comment.id && item.body === "Durable Confluence comment"), true);
  const nextComment = (await a.request(`/jira/rest/api/2/issue/${issue.key}/comment`, "POST", { body: "Next comment" })).value;
  assert.equal(Number(nextComment.id), Number(comment.id) + 1);
  const newIssue = (await a.request("/jira/rest/api/2/issue", "POST", { fields: { project: { key: issue.project }, issuetype: { name: "Task" }, summary: "Allocated after restart" } })).value;
  assert.equal(Number(newIssue.id), before.jira.nextId);
  const newPage = await a.tool("confluence_create_page", { space_key: "HB", title: "Allocated after restart", content: "Saved", include_content: true });
  assert.equal(Number(newPage.page.id), before.confluence.nextId);
  assert.equal((await a.state()).audit.at(-1).sequence > before.audit.at(-1).sequence, true);
  assert.equal((await b.state()).jira.issues[0].summary, initial.jira.issues[0].summary);
  await a.request("/reset", "POST", {}); await a.stop(); a = await launch(t, "atlassian", file);
  assert.deepEqual((await a.state()).jira, initial.jira);
  assert.equal((await b.tool("confluence_get_comments", { page_id: page.id })).some((item) => item.id === other.comment.id && item.body === "Other participant only"), true);
});

for (const service of ["microsoft365", "atlassian"]) {
  test(`${service} fails before ready on corruption, incompatible snapshots and wrong identity`, async (t) => {
    const dir = directory(t), file = join(dir, "state.sqlite"); writeFileSync(file, "corrupt database");
    await launch(t, service, file, alex, true); rmSync(file);
    const a = await launch(t, service, file); await a.stop();
    await launch(t, service, file, priya, true);
    const store = createSnapshotStore({ file }); store.write(service, { version: 999, identity: alex }); store.close();
    await launch(t, service, file, alex, true);
  });
  test(`${service} never acknowledges mutations when snapshot storage fails, and fails closed until restart`, async (t) => {
    const dir = directory(t), file = join(dir, "state.sqlite"); const a = await launch(t, service, file);
    const db = new DatabaseSync(file);
    db.exec("CREATE TRIGGER reject_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
    const response = service === "microsoft365"
      ? await a.request("/v1.0/me/messages", "POST", { subject: "Must not succeed" })
      : await a.request("/jira/rest/api/2/issue", "POST", { fields: { project: { key: "ENG" }, issuetype: { name: "Task" }, summary: "Must not succeed" } });
    assert.equal(response.status, 500);
    assert.equal((await a.request("/state")).status, 500);
    assert.equal((await a.request("/reset", "POST", {})).status, 500);
    db.exec("DROP TRIGGER reject_update"); db.close(); await a.stop();
    const reopened = await launch(t, service, file);
    assert.equal(JSON.stringify(await reopened.state()).includes("Must not succeed"), false);
  });
  test(`${service} without a state file still resets on restart`, async (t) => {
    const a = await launch(t, service); const before = await a.state();
    if (service === "microsoft365") await a.tool("mail_create_folder", { name: "Ephemeral" });
    else await a.request(`/jira/rest/api/2/issue/${before.jira.issues[0].key}/comment`, "POST", { body: "Ephemeral" });
    await a.stop(); const b = await launch(t, service);
    assert.deepEqual(await b.state(), before);
  });
}
