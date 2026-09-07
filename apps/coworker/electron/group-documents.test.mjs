import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createGroup, updateGroup, archiveGroup, normalizeEvent, readGroupTimeline } from "./groups.mjs";
import { createDocument } from "./documents.mjs";
import { assertGroupDocumentToolContext, createGroupDocumentService, createGroupDocuments, groupDocumentToolCatalog, validateGroupDocumentArguments } from "./group-documents.mjs";
import { GROUP_DOCUMENT_PLUGIN, installGroupDocumentPlugin } from "./group-document-plugin.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "group-documents-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "editor"));
  const person = Object.freeze({});
  const writer = Object.freeze({});
  const outsider = Object.freeze({});
  const group = await createGroup(directory, { name: "Planning", participantSlugs: ["editor", "researcher"] });
  const other = await createGroup(directory, { name: "Other work", participantSlugs: ["editor", "operations"] });
  const callers = new WeakMap([
    [person, { kind: "person" }],
    [writer, { kind: "coworker", slug: "editor", name: "Editor", groupId: group.id }],
    [outsider, { kind: "coworker", slug: "operations", name: "Operations" }],
  ]);
  const resolveCaller = async (context) => {
    if (!callers.has(context)) throw new Error("No admitted native call.");
    return callers.get(context);
  };
  const options = { coworkersDir: directory, resolveCaller };
  return { directory, person, writer, outsider, callers, group, other, options, store: createGroupDocuments(options) };
}

test("group identity, trusted attribution, history and restore survive reopening", async (t) => {
  const f = await fixture(t);
  const first = await f.store.save(f.group.id, { title: "Plan", body: "First draft", summary: "Shared plan", highlights: ["Review scope"] }, f.writer);
  assert.equal(first.author, "Editor");
  assert.equal(first.authorSlug, "editor");
  assert.equal(first.groupId, f.group.id);
  const second = await f.store.save(f.group.id, { id: first.id, expectedRevision: 1, title: "Plan", body: "Person's edit" }, f.person);
  assert.equal(second.revision, 2);
  assert.equal(second.author, "You");
  assert.equal(second.updatedBy, "person");
  assert.equal(second.authorSlug, "");
  assert.equal(second.summary, "Shared plan");
  const reopened = createGroupDocuments(f.options);
  const history = await reopened.revisions(f.group.id, first.id, f.writer);
  assert.deepEqual(history.map((entry) => [entry.revision, entry.author, entry.authorSlug]), [[1, "Editor", "editor"]]);
  const restored = await reopened.restore(f.group.id, first.id, 1, 2, f.person);
  assert.equal(restored.revision, 3);
  assert.equal(restored.body, first.body);
  assert.equal(restored.author, "You");
  assert.equal(restored.createdAt, first.createdAt);
  assert.deepEqual((await reopened.revisions(f.group.id, first.id, f.person)).map((entry) => entry.revision), [2, 1]);
  const [summary] = await reopened.list(f.group.id, f.person);
  assert.equal(summary.groupId, f.group.id);
  assert.equal(summary.words, 2);
  assert.equal(Object.hasOwn(summary, "body"), false);
});

test("all reads and writes require verified caller context and current membership", async (t) => {
  const f = await fixture(t);
  const doc = await f.store.save(f.group.id, { title: "Plan", body: "Only shared here" }, f.person);
  const operations = (context) => [
    () => f.store.list(f.group.id, context),
    () => f.store.read(f.group.id, doc.id, context),
    () => f.store.revisions(f.group.id, doc.id, context),
    () => f.store.save(f.group.id, { id: doc.id, expectedRevision: 1, title: "Plan", body: "Overwrite" }, context),
    () => f.store.restore(f.group.id, doc.id, 1, 1, context),
  ];
  for (const context of [undefined, "editor", { kind: "person" }, structuredClone(f.writer), f.outsider]) {
    for (const operation of operations(context)) await assert.rejects(operation);
  }
  await assert.rejects(() => f.store.list(f.other.id, f.writer), /not available/);
  await updateGroup(f.directory, f.group.id, { participantSlugs: ["researcher", "operations"] });
  for (const operation of operations(f.writer)) await assert.rejects(operation, /not available/);
  await archiveGroup(f.directory, f.group.id);
  for (const operation of operations(f.person)) await assert.rejects(operation, /not available/);
});

test("same document names in two groups and private documents never share storage", async (t) => {
  const f = await fixture(t);
  const first = await f.store.save(f.group.id, { title: "Plan", body: "First group" }, f.person);
  const second = await f.store.save(f.other.id, { title: "Plan", body: "Second group" }, f.person);
  await createDocument(f.directory, "editor", { title: "Private notes", body: "Not shared" });
  assert.equal(first.id, second.id);
  assert.notEqual(first.groupId, second.groupId);
  assert.equal((await f.store.read(f.group.id, first.id, f.writer)).body, "First group\n");
  assert.equal((await f.store.read(f.other.id, second.id, f.outsider)).body, "Second group\n");
  assert.equal((await f.store.list(f.group.id, f.person)).length, 1);
  await assert.rejects(() => f.store.read(f.group.id, "private-notes", f.person));
});

test("concurrent writers across store instances get one winner and a recoverable conflict", async (t) => {
  const f = await fixture(t);
  const doc = await f.store.save(f.group.id, { title: "Plan", body: "Initial" }, f.person);
  const otherStore = createGroupDocuments(f.options);
  const results = await Promise.allSettled([
    f.store.save(f.group.id, { id: doc.id, expectedRevision: 1, title: "Plan", body: "Editor change" }, f.writer),
    otherStore.save(f.group.id, { id: doc.id, expectedRevision: 1, title: "Plan", body: "Person change" }, f.person),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "GROUP_DOCUMENT_CONFLICT");
  assert.equal(rejected.reason.currentRevision, 2);
  await assert.rejects(() => f.store.restore(f.group.id, doc.id, 1, 1, f.person), { code: "GROUP_DOCUMENT_CONFLICT" });
  const latest = await f.store.read(f.group.id, doc.id, f.person);
  const noChange = await f.store.save(f.group.id, { id: doc.id, expectedRevision: latest.revision, title: latest.title, body: latest.body }, f.person);
  assert.equal(noChange.changed, false);
  assert.equal(noChange.author, latest.author);
  const created = await Promise.all([f.store, otherStore].map((store) => store.save(f.group.id, { title: "Another plan", body: "Draft" }, f.person)));
  assert.equal(new Set(created.map((entry) => entry.id)).size, 2);
  const empty = await f.store.save(f.group.id, { title: "Empty draft", body: "" }, f.person);
  const stillEmpty = await f.store.save(f.group.id, { id: empty.id, expectedRevision: 1, title: empty.title, body: "" }, f.writer);
  assert.equal(stillEmpty.changed, false);
  assert.equal(stillEmpty.revision, 1);
});

test("keeps five earlier revisions and restore always creates a new attributed revision", async (t) => {
  const f = await fixture(t);
  let doc = await f.store.save(f.group.id, { title: "Plan", body: "Draft 1" }, f.writer);
  for (let revision = 2; revision <= 8; revision++) {
    doc = await f.store.save(f.group.id, { id: doc.id, expectedRevision: doc.revision, title: "Plan", body: `Draft ${revision}` }, f.person);
  }
  assert.deepEqual((await f.store.revisions(f.group.id, doc.id, f.writer)).map((entry) => entry.revision), [7, 6, 5, 4, 3]);
  await assert.rejects(() => f.store.restore(f.group.id, doc.id, 1, 8, f.person), /no longer available/);
  doc = await f.store.restore(f.group.id, doc.id, 7, 8, f.writer);
  assert.equal(doc.revision, 9);
  assert.equal(doc.author, "Editor");
  doc = await f.store.restore(f.group.id, doc.id, 7, 9, f.person);
  assert.equal(doc.revision, 10);
  assert.equal(doc.author, "You");
});

test("rejects paths, spoofed authors, invalid revisions, oversized bodies and secrets", async (t) => {
  const f = await fixture(t);
  const doc = await f.store.save(f.group.id, { title: "Plan", body: "Draft" }, f.person);
  const base = { id: doc.id, expectedRevision: 1, title: "Plan", body: "Changed" };
  for (const extra of [{ author: "Someone else" }, { authorSlug: "researcher" }, { slug: "editor" }, { path: "/tmp/outside" }, { groupId: f.other.id },
    { id: "../plan" }, { expectedRevision: "1" }, { expectedRevision: 0 }, { expectedRevision: 1.5 }, { body: "x".repeat(100_001) },
    { title: "x".repeat(121) }, { body: "-----BEGIN PRIVATE KEY-----" }]) {
    await assert.rejects(() => f.store.save(f.group.id, { ...base, ...extra }, f.person));
  }
  for (const id of ["../plan", "/tmp/plan", "index", "nested/plan"]) {
    await assert.rejects(() => f.store.read(f.group.id, id, f.person));
    await assert.rejects(() => f.store.revisions(f.group.id, id, f.person));
  }
  await assert.rejects(() => f.store.list("../outside", f.person));
  await assert.rejects(() => f.store.restore(f.group.id, doc.id, "../../plan", 1, f.person));
  assert.equal((await f.store.read(f.group.id, doc.id, f.person)).revision, 1);
});

test("refuses symlinks and a document whose embedded identity names another group", async (t) => {
  const f = await fixture(t);
  const doc = await f.store.save(f.group.id, { title: "Plan", body: "Draft" }, f.person);
  const home = path.join(f.directory, ".groups", f.group.id, "shared", "documents");
  await symlink(path.join(home, "plan.md"), path.join(home, "linked.md"));
  await assert.rejects(() => f.store.read(f.group.id, "linked", f.person), /symbolic links/);
  await assert.rejects(() => f.store.list(f.group.id, f.person), /symbolic links/);
  await symlink(path.join(f.directory, ".groups", f.group.id, "shared"), path.join(f.directory, ".groups", f.other.id, "shared"));
  await assert.rejects(() => f.store.save(f.other.id, { title: "Outside", body: "No" }, f.person), /symbolic links/);
  const raw = await readFile(path.join(home, "plan.md"), "utf8");
  await writeFile(path.join(home, "plan.md"), raw.replace(f.group.id, f.other.id));
  await assert.rejects(() => f.store.read(f.group.id, doc.id, f.person), /identity or author/);
  await mkdir(path.join(home, ".history"), { recursive: true });
  await symlink(home, path.join(home, ".history", "plan"));
  await writeFile(path.join(home, "plan.md"), raw);
  await assert.rejects(() => f.store.revisions(f.group.id, doc.id, f.person), /symbolic links/);
});

test("a caller revoked while an operation waits cannot write", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const store = createGroupDocuments({ ...f.options, resolveCaller: async (context) => {
    if (++calls === 2) throw new Error("The native execution ended.");
    return f.options.resolveCaller(context);
  } });
  await assert.rejects(() => store.save(f.group.id, { title: "No write", body: "Draft" }, f.writer), /execution ended/);
  assert.deepEqual(await f.store.list(f.group.id, f.person), []);
  calls = 0;
  const membershipStore = createGroupDocuments({ ...f.options, resolveCaller: async (context) => {
    if (++calls === 2) await updateGroup(f.directory, f.group.id, { participantSlugs: ["researcher", "operations"] });
    return f.options.resolveCaller(context);
  } });
  await assert.rejects(() => membershipStore.save(f.group.id, { title: "No write", body: "Draft" }, f.writer), /not available/);
  assert.deepEqual(await f.store.list(f.group.id, f.person), []);
});

test("the native tool contract never lets the model choose its author or context", () => {
  const catalog = groupDocumentToolCatalog();
  assert.equal(catalog.length, 5);
  for (const { inputSchema } of catalog) {
    assert.equal(inputSchema.additionalProperties, false);
    for (const key of ["slug", "author", "authorSlug", "context", "sessionID", "messageID", "callID", "path"]) assert.equal(Object.hasOwn(inputSchema.properties, key), false);
  }
  const save = catalog.find((tool) => tool.name === "group_document_save");
  assert.deepEqual(save.inputSchema.dependentRequired, { id: ["expectedRevision"], expectedRevision: ["id"] });
});

test("main-side validation applies the exact catalog, including strict fields and revision dependencies", () => {
  const groupId = "grp_12345678";
  const inputs = [{ groupId }, { groupId, id: "plan" }, { groupId, title: "Plan", body: "Draft" },
    { groupId, id: "plan" }, { groupId, id: "plan", revision: 1, expectedRevision: 2 }];
  for (const [index, tool] of groupDocumentToolCatalog().entries()) {
    assert.deepEqual(validateGroupDocumentArguments(tool.name, inputs[index]), inputs[index]);
    for (const extra of [{ author: "You" }, { slug: "editor" }, { groupId: "../outside" }, { path: "/private" }]) {
      assert.throws(() => validateGroupDocumentArguments(tool.name, { ...inputs[index], ...extra }), /Invalid/);
    }
  }
  for (const extra of [{ id: "plan" }, { expectedRevision: 1 }, { id: "plan", expectedRevision: 1.5 },
    { summary: "x".repeat(241) }, { highlights: ["x".repeat(161)] }, { body: "x".repeat(100001) }]) {
    assert.throws(() => validateGroupDocumentArguments("group_document_save", { ...inputs[2], ...extra }), /Invalid/);
  }
  assert.throws(() => validateGroupDocumentArguments("document_save", inputs[2]), /Unknown/);
});

function documentWitness(groupId = "grp_12345678", directory = "/native/workspace") {
  const args = { groupId, title: "Plan", body: "Draft" };
  return {
    slug: "editor", name: "coworker_group_document_save", args, workspaceId: "workspace-one", active: true,
    context: { sessionID: "session-one", messageID: "assistant-one", callID: "call-one", directory },
    entry: { id: "execution-one", state: "running", sentAt: 1, workspaceId: "workspace-one", messageId: "parent-one",
      owner: { slug: "editor", threadId: "session-one", kind: "group", groupId, conversationId: groupId } },
    snapshot: { threadId: "session-one", directory, messages: [
      { id: "parent-one", role: "user", parts: [{ type: "text", text: "Update our shared plan." }] },
      { id: "assistant-one", role: "assistant", parentId: "parent-one", completedAt: null, parts: [
        { type: "tool", callId: "call-one", tool: "coworker_group_document_save", toolStatus: "running", toolInput: structuredClone(args) },
      ] },
    ] },
  };
}

test("native admission requires the exact active group, workspace, parent and running tool input", () => {
  assert.doesNotThrow(() => assertGroupDocumentToolContext(documentWitness()));
  const consultation = documentWitness();
  consultation.entry.owner.kind = "consultation";
  assert.doesNotThrow(() => assertGroupDocumentToolContext(consultation));
  for (const mutate of [
    (w) => { w.active = false; }, (w) => { w.entry.state = "queued"; }, (w) => { w.entry.sentAt = null; },
    (w) => { w.entry.owner.kind = "private"; }, (w) => { w.entry.owner.kind = "worker"; },
    (w) => { w.slug = "operations"; }, (w) => { w.entry.owner.groupId = "grp_87654321"; },
    (w) => { w.args.groupId = "grp_87654321"; w.snapshot.messages[1].parts[0].toolInput.groupId = w.args.groupId; },
    (w) => { w.workspaceId = "other-workspace"; }, (w) => { w.context.directory = "/private"; },
    (w) => { w.context.sessionID = "other-session"; }, (w) => { w.snapshot.threadId = "other-session"; },
    (w) => { w.context.messageID = "other-message"; }, (w) => { w.context.callID = "other-call"; },
    (w) => { w.snapshot.messages[0].parts[0].synthetic = true; }, (w) => { w.snapshot.messages[1].parentId = "other-parent"; },
    (w) => { w.snapshot.messages[1].completedAt = 2; }, (w) => { w.snapshot.messages[1].error = { message: "Stopped" }; },
    (w) => { w.snapshot.messages[1].parts[0].tool = "coworker_document_create"; },
    (w) => { w.snapshot.messages[1].parts[0].toolStatus = "completed"; },
    (w) => { w.snapshot.messages[1].parts[0].toolInput.body = "Different input"; },
  ]) {
    const witness = documentWitness();
    mutate(witness);
    assert.throws(() => assertGroupDocumentToolContext(witness), /exact running tool call/);
  }
});

test("person and native routing share storage without accepting payload identities", async (t) => {
  const f = await fixture(t);
  const witness = documentWitness(f.group.id, path.join(f.directory, "editor"));
  let active = true;
  const assertActive = () => { if (!active) throw new Error("Native execution stopped."); };
  const service = createGroupDocumentService({
    coworkersDir: f.directory,
    coworkerFor: async (slug) => ({ slug, name: "Editor", workspaceId: witness.workspaceId, path: witness.context.directory }),
    resolveContext: async (slug, context, expected) => {
      assertActive();
      assertGroupDocumentToolContext({ ...witness, slug, context, ...expected });
      return { entry: witness.entry, assertActive };
    },
  });
  async function native(name, args, context = witness.context) {
    witness.snapshot.messages[1].parts[0].tool = `coworker_${name}`;
    witness.snapshot.messages[1].parts[0].toolInput = structuredClone(args);
    return JSON.parse((await service.executeNative("editor", { name, args, context })).text);
  }
  const created = await service.save(f.group.id, { title: "Plan", body: "Person's draft" });
  assert.equal(created.author, "You");
  assert.equal((await service.read(f.group.id, created.id)).revision, 1);
  const updated = await native("group_document_save", { groupId: f.group.id, id: created.id, expectedRevision: 1, title: "Plan", body: "Editor's revision" }, { ...witness.context, kind: "person", slug: "operations", name: "Someone else" });
  assert.equal(updated.author, "Editor");
  assert.equal(updated.authorSlug, "editor");
  assert.equal(updated.groupId, f.group.id);
  assert.equal((await native("group_document_read", { groupId: f.group.id, id: created.id })).revision, 2);
  assert.equal((await native("group_documents", { groupId: f.group.id })).length, 1);
  assert.equal((await native("group_document_revisions", { groupId: f.group.id, id: created.id }))[0].author, "You");
  const restored = await native("group_document_restore", { groupId: f.group.id, id: created.id, revision: 1, expectedRevision: 2 });
  assert.equal(restored.revision, 3);
  assert.equal(restored.author, "Editor");
  await assert.rejects(() => service.save(f.group.id, { id: created.id, expectedRevision: 2, title: "Plan", body: "Stale" }), { code: "GROUP_DOCUMENT_CONFLICT" });
  await assert.rejects(() => native("group_document_save", { groupId: f.group.id, title: "Secret", body: "-----BEGIN PRIVATE KEY-----" }), /credentials/);
  await assert.rejects(() => native("group_documents", { groupId: f.other.id }), /originating group/);
  const events = await readGroupTimeline(f.directory, f.group.id);
  assert.deepEqual(events.map((event) => [event.status, event.documentId, event.revision, event.slug ?? ""]), [
    ["document", created.id, 1, ""], ["document", created.id, 2, "editor"], ["document", created.id, 3, "editor"],
  ]);
  active = false;
  await assert.rejects(() => native("group_documents", { groupId: f.group.id }), /stopped/);
  assert.equal((await service.read(f.group.id, created.id)).revision, 3);
});

test("native service rechecks group membership and the coworker's actual workspace before writing", async (t) => {
  const f = await fixture(t);
  const witness = documentWitness(f.group.id, path.join(f.directory, "editor"));
  let lookups = 0;
  let actualWorkspaceId = witness.workspaceId;
  const service = createGroupDocumentService({
    coworkersDir: f.directory,
    coworkerFor: async (slug) => {
      if (++lookups === 2) await updateGroup(f.directory, f.group.id, { participantSlugs: ["researcher", "operations"] });
      return { slug, name: "Editor", workspaceId: actualWorkspaceId, path: witness.context.directory };
    },
    resolveContext: async (slug, context, expected) => {
      assertGroupDocumentToolContext({ ...witness, slug, context, ...expected });
      return { entry: witness.entry, assertActive() {} };
    },
  });
  await assert.rejects(() => service.executeNative("editor", { name: "group_document_save", args: witness.args, context: witness.context }), /not available/);
  assert.deepEqual(await service.list(f.group.id), []);
  await archiveGroup(f.directory, f.group.id);
  await assert.rejects(() => service.list(f.group.id), /not available/);
  await assert.rejects(() => service.executeNative("editor", { name: "group_document_save", args: witness.args, context: witness.context }), /not available/);
  actualWorkspaceId = "replacement-workspace";
  await assert.rejects(() => service.executeNative("editor", { name: "group_document_save", args: witness.args, context: witness.context }), /workspace changed/);
});

test("native document access accepts canonical workspace aliases but not a different directory", async (t) => {
  const f = await fixture(t);
  const actualPath = await realpath(path.join(f.directory, "editor"));
  const alias = path.join(f.directory, "editor-alias");
  await symlink(actualPath, alias, "dir");
  let coworkerPath = alias;
  const witness = documentWitness(f.group.id, actualPath);
  const service = createGroupDocumentService({
    coworkersDir: f.directory,
    coworkerFor: async (slug) => ({ slug, name: "Editor", workspaceId: witness.workspaceId, path: coworkerPath }),
    resolveContext: async (slug, context, expected) => {
      assertGroupDocumentToolContext({ ...witness, slug, context, ...expected });
      return { entry: witness.entry, assertActive() {} };
    },
  });
  const request = { name: "group_document_save", args: witness.args, context: witness.context };
  const saved = JSON.parse((await service.executeNative("editor", request)).text);
  assert.equal(saved.author, "Editor");
  assert.equal(saved.groupId, f.group.id);
  coworkerPath = path.join(f.directory, "different-workspace");
  await mkdir(coworkerPath);
  await assert.rejects(() => service.executeNative("editor", request), /workspace changed/);
  assert.equal((await service.list(f.group.id)).length, 1);
});

test("announcement failure never fails or repeats a committed save and document events retain valid identities", async (t) => {
  const f = await fixture(t);
  let announcements = 0;
  const service = createGroupDocumentService({ coworkersDir: f.directory, publish: async () => { announcements++; throw new Error("Timeline unavailable."); } });
  const saved = await service.save(f.group.id, { title: "Plan", body: "Saved even without its announcement" });
  assert.equal(saved.announcementFailed, true);
  assert.equal((await service.read(f.group.id, saved.id)).revision, 1);
  const unchanged = await service.save(f.group.id, { id: saved.id, expectedRevision: 1, title: saved.title, body: saved.body });
  assert.equal(unchanged.changed, false);
  assert.equal(announcements, 1);
  assert.deepEqual(await service.revisions(f.group.id, saved.id), []);
  assert.equal(normalizeEvent({ kind: "status", status: "document", documentId: saved.id, revision: 1 }).documentId, saved.id);
  for (const extra of [{ documentId: "../private", revision: 1 }, { documentId: saved.id }, { documentId: saved.id, revision: "1" }]) {
    assert.throws(() => normalizeEvent({ kind: "status", ...extra }), /document id and revision/);
  }
});

// Exercise generated transport without the native SDK or a running HTTP service.
// The small SDK double records the exact argument shape as well as validating test inputs.
function pluginSchema(type, items) {
  const json = { type, ...(items ? { items: items.json } : {}) };
  return {
    json, isOptional: false,
    min(value) { json[type === "string" ? "minLength" : "minimum"] = value; return this; },
    max(value) { json[type === "string" ? "maxLength" : "maxItems"] = value; return this; },
    int() { json.type = "integer"; return this; },
    regex(value) { json.pattern = value.source; return this; },
    optional() { this.isOptional = true; return this; },
    parse(value) {
      if (value === undefined && this.isOptional) return value;
      if (json.type === "string" && (typeof value !== "string" || value.length < (json.minLength ?? 0)
        || value.length > (json.maxLength ?? Infinity) || (json.pattern && !new RegExp(json.pattern).test(value)))) throw new Error("Invalid string argument.");
      if (json.type === "integer" && (!Number.isInteger(value) || value < json.minimum)) throw new Error("Invalid revision argument.");
      if (json.type === "array") {
        if (!Array.isArray(value) || value.length > json.maxItems) throw new Error("Invalid highlights argument.");
        value.forEach((entry) => items.parse(entry));
      }
      return value;
    },
  };
}

async function generatedPlugin(fetch, read = async () => JSON.stringify({ url: "http://127.0.0.1:1/context", token: "fixture-only" })) {
  const tool = (definition) => definition;
  tool.schema = {
    string: () => pluginSchema("string"), number: () => pluginSchema("number"), array: (items) => pluginSchema("array", items),
    object: (shape) => ({ strict: () => ({ parse: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !Object.hasOwn(shape, key))) throw new Error("Unexpected tool arguments.");
      for (const [key, schema] of Object.entries(shape)) schema.parse(input[key]);
      return structuredClone(input);
    } }) }),
  };
  const factory = new Function("tool", "readFile", "path", "fetch", "AbortSignal", GROUP_DOCUMENT_PLUGIN
    .replace(/^import .*;\n/gm, "").replace("export default", "return"))(tool, read, path, fetch, AbortSignal);
  return factory({ directory: "/native/workspace" });
}

const nativeContext = (extra = {}) => ({ sessionID: "session-one", messageID: "message-one", callID: "call-one", directory: "/native/workspace", abort: new AbortController().signal, ...extra });

test("generated native plugin is valid JavaScript and exposes exactly the catalog fields", async () => {
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: GROUP_DOCUMENT_PLUGIN });
  const plugin = await generatedPlugin(() => { throw new Error("No request expected."); });
  const catalog = groupDocumentToolCatalog();
  assert.deepEqual(Object.keys(plugin.tool), catalog.map((entry) => `coworker_${entry.name}`));
  for (const { name, description, inputSchema } of catalog) {
    const native = plugin.tool[`coworker_${name}`];
    assert.equal(native.description, description);
    assert.deepEqual(Object.fromEntries(Object.entries(native.args).map(([key, schema]) => [key, schema.json])), inputSchema.properties);
    assert.deepEqual(Object.entries(native.args).filter(([, schema]) => !schema.isOptional).map(([key]) => key), inputSchema.required);
  }
});

test("native plugin stamps every tool with context and sends one authenticated text request", async () => {
  const requests = [];
  const reads = [];
  const plugin = await generatedPlugin(async (url, options) => {
    requests.push({ url, ...options });
    return { ok: true, json: async () => ({ text: "Recorded result", structured: { ignored: true } }) };
  }, async (file) => { reads.push(file); return JSON.stringify({ url: "http://127.0.0.1:1/context", token: "fixture-only" }); });
  const groupId = "grp_12345678";
  const inputs = [
    { groupId }, { groupId, id: "plan" }, { groupId, title: "Plan", body: "Draft" },
    { groupId, id: "plan" }, { groupId, id: "plan", revision: 1, expectedRevision: 2 },
  ];
  for (const [index, { name }] of groupDocumentToolCatalog().entries()) {
    const context = nativeContext({ callID: `call-${index}`, directory: "/native/current-directory" });
    const result = await plugin.tool[`coworker_${name}`].execute(inputs[index], context);
    assert.equal(result, "Recorded result");
    const request = requests[index];
    assert.equal(request.url, "http://127.0.0.1:1/context");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer fixture-only");
    assert.equal(request.redirect, "error");
    assert.deepEqual(JSON.parse(request.body), {
      name, args: inputs[index], context: { sessionID: context.sessionID, messageID: context.messageID, callID: context.callID, directory: context.directory },
    });
    assert.equal(reads[index], path.join("/native/workspace", ".opencode", "coworker-context.json"));
  }
  assert.equal(requests.length, 5);
});

test("hook call identities are consumed exactly once without mixing direct or parallel calls", async () => {
  const requests = [];
  const plugin = await generatedPlugin(async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ text: "Read" }) };
  });
  const tool = "coworker_group_document_read";
  const args = { id: "plan", groupId: "grp_12345678" };
  for (const callID of ["first", "second"]) await plugin["tool.execute.before"]({ sessionID: "session-one", tool, callID }, { args });
  await plugin.tool[tool].execute(args, nativeContext({ callID: "second" }));
  await plugin.tool[tool].execute(args, nativeContext({ callID: undefined, directory: undefined }));
  assert.deepEqual(requests.map((entry) => entry.context.callID), ["second", "first"]);
  assert.equal(requests[1].context.directory, "/native/workspace");
  await assert.rejects(() => plugin.tool[tool].execute(args, nativeContext({ callID: undefined })), /tool-call identity/);
  await plugin["tool.execute.before"]({ sessionID: "other-session", tool, callID: "other-call" }, { args });
  await assert.rejects(() => plugin.tool[tool].execute(args, nativeContext({ callID: undefined })), /tool-call identity/);
  await plugin["tool.execute.before"]({ sessionID: "session-one", tool: "coworker_document_read", callID: "legacy-call" }, { args });
  await assert.rejects(() => plugin.tool[tool].execute(args, nativeContext({ callID: undefined })), /tool-call identity/);
  assert.equal(requests.length, 2);
});

test("native plugin rejects authority fields, invalid input and missing or aborted identity before transport", async () => {
  let requests = 0;
  const plugin = await generatedPlugin(async () => { requests++; throw new Error("No request expected."); });
  const tool = plugin.tool.coworker_group_document_save;
  const input = { groupId: "grp_12345678", title: "Plan", body: "Draft" };
  for (const extra of [{ slug: "editor" }, { name: "Editor" }, { author: "You" }, { directory: "/other" }, { context: nativeContext() },
    { id: "plan" }, { expectedRevision: 1 }, { id: "plan", expectedRevision: 0 }, { body: "x".repeat(100001) }, { groupId: "../outside" }]) {
    await assert.rejects(() => tool.execute({ ...input, ...extra }, nativeContext()));
  }
  for (const extra of [{ sessionID: "" }, { messageID: "" }, { callID: undefined }, { abort: undefined }, { abort: AbortSignal.abort(new Error("Stopped")) }]) {
    await assert.rejects(() => tool.execute(input, nativeContext(extra)));
  }
  assert.equal(requests, 0);
});

test("native plugin forwards server failures without retries and propagates cancellation", async () => {
  let requests = 0;
  let signal;
  const plugin = await generatedPlugin(async (_url, options) => {
    requests++; signal = options.signal;
    return { ok: false, json: async () => ({ error: "This document changed. Read revision 2." }) };
  });
  const controller = new AbortController();
  await assert.rejects(() => plugin.tool.coworker_group_documents.execute({ groupId: "grp_12345678" }, nativeContext({ abort: controller.signal })), /Read revision 2/);
  assert.equal(requests, 1);
  controller.abort();
  assert.equal(signal.aborted, true);
  const malformed = await generatedPlugin(async () => ({ ok: true, json: async () => ({ content: [] }) }));
  await assert.rejects(() => malformed.tool.coworker_group_documents.execute({ groupId: "grp_12345678" }, nativeContext()), /did not contain text/);
});

test("installer preserves connection and other configuration, repairs source and never duplicates registration", async (t) => {
  const f = await fixture(t);
  const coworker = { path: path.join(f.directory, "editor") };
  await mkdir(path.join(coworker.path, ".opencode"), { recursive: true });
  const configFile = path.join(coworker.path, "opencode.json");
  const connectionFile = path.join(coworker.path, ".opencode", "coworker-context.json");
  const before = { plugin: ["file:///existing-plugin.js"], permission: { read: "ask" }, tools: { bash: false }, model: "provider/model" };
  const connection = JSON.stringify({ url: "http://127.0.0.1:1/context", token: "fixture-only" });
  await writeFile(configFile, JSON.stringify(before));
  await writeFile(connectionFile, connection, { mode: 0o600 });
  await installGroupDocumentPlugin(coworker);
  const sourceFile = path.join(coworker.path, ".opencode", "coworker-group-documents.js");
  assert.equal(await readFile(sourceFile, "utf8"), GROUP_DOCUMENT_PLUGIN);
  assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), { ...before, plugin: [...before.plugin, pathToFileURL(sourceFile).href] });
  const installed = await readFile(configFile, "utf8");
  await writeFile(sourceFile, "outdated source");
  await installGroupDocumentPlugin(coworker);
  await installGroupDocumentPlugin(coworker);
  assert.equal(await readFile(sourceFile, "utf8"), GROUP_DOCUMENT_PLUGIN);
  assert.equal(await readFile(configFile, "utf8"), installed);
  assert.equal(await readFile(connectionFile, "utf8"), connection);
});
