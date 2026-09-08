import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.mjs";
import {
  ACTIVE_SET_TARGET,
  HISTORY_LIMIT,
  archiveDocument,
  createDocument,
  documentIdFor,
  ensureDocumentsHome,
  findSecretLike,
  isDocumentId,
  listDocuments,
  listRevisions,
  listSections,
  normalizeHighlights,
  parseDocument,
  patchSection,
  readDocument,
  readStyleEvents,
  recordStyleEvent,
  renderDocumentsIndex,
  restoreRevision,
  serializeDocument,
  setContext,
  setDocumentStatus,
  styleReminder,
  updateDocument,
} from "./documents.mjs";

const SLUG = "nova";

async function home() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "coworker-documents-"));
  await mkdir(path.join(dir, SLUG, "memory"), { recursive: true });
  await writeFile(path.join(dir, SLUG, "coworker.md"), "---\nname: Nova\n---\n", "utf8");
  return dir;
}

test("frontmatter round-trips strings, arrays, and numbers deterministically", () => {
  const text = serializeFrontmatter(
    { id: "launch-plan", title: "Launch plan: Q3", highlights: ["Ship by Friday", "Two owners"], revision: 3, empty: null, code: "007" },
    "\nBody here\n",
  );
  assert.equal(text, [
    "---",
    "id: launch-plan",
    "title: \"Launch plan: Q3\"",
    "highlights: [\"Ship by Friday\",\"Two owners\"]",
    "revision: 3",
    "code: \"007\"",
    "---",
    "",
    "Body here",
    "",
  ].join("\n"));
  const parsed = parseFrontmatter(text);
  assert.deepEqual(parsed.data, { id: "launch-plan", title: "Launch plan: Q3", highlights: ["Ship by Friday", "Two owners"], revision: 3, code: "007" });
  assert.equal(parsed.body, "\nBody here\n");
  assert.deepEqual(parseFrontmatter("no frontmatter"), { data: {}, body: "no frontmatter" });
});

test("a document serializes to readable frontmatter and parses back with safe defaults", () => {
  const document = {
    id: "launch-plan",
    title: "Launch plan",
    summary: "Ship the new onboarding by the end of Q3.",
    highlights: ["Three phases", "Two owners"],
    status: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    updatedBy: "coworker",
    revision: 2,
    body: "## Timeline\n\nWeek one.\n",
  };
  const text = serializeDocument(document);
  assert.match(text, /^---\nid: launch-plan\ntitle: Launch plan\n/);
  assert.deepEqual(parseDocument(text), document);
  const sparse = parseDocument("---\nstatus: bogus\nrevision: zero\n---\n\nJust a body\n", "fallback-id");
  assert.equal(sparse.id, "fallback-id");
  assert.equal(sparse.title, "Untitled document");
  assert.equal(sparse.status, "active");
  assert.equal(sparse.revision, 1);
  assert.equal(sparse.updatedBy, "coworker");
  assert.equal(sparse.body, "Just a body\n");
});

test("ids are derived from titles, validated, and never collide with the index", () => {
  assert.equal(documentIdFor("Launch plan: Q3 — Onboarding"), "launch-plan-q3-onboarding");
  assert.equal(documentIdFor("   "), "document");
  assert.equal(documentIdFor("Index"), "index-1");
  assert.equal(isDocumentId("launch-plan"), true);
  assert.equal(isDocumentId("index"), false);
  assert.equal(isDocumentId("../escape"), false);
  assert.equal(isDocumentId("Bad Caps"), false);
  assert.equal(isDocumentId("double--dash"), false);
  assert.deepEqual(normalizeHighlights(["- One", "", "  Two  ", "Three", "Four", "Five", "Six"]), ["One", "Two", "Three", "Four", "Five"]);
  assert.deepEqual(normalizeHighlights("A\nB"), ["A", "B"]);
});

test("patching replaces exactly one ## section by heading, or appends a new one", () => {
  const body = "Intro paragraph.\n\n## Timeline\n\nWeek one.\n\n### Detail\n\nNested.\n\n## Risks\n\nNone yet.\n";
  const replaced = patchSection(body, "timeline", "Week one and two.");
  assert.equal(replaced.action, "replaced");
  assert.equal(replaced.body, "Intro paragraph.\n\n## timeline\n\nWeek one and two.\n\n## Risks\n\nNone yet.\n");
  const last = patchSection(body, "## Risks", "Vendor delay.");
  assert.equal(last.action, "replaced");
  assert.ok(last.body.endsWith("## Risks\n\nVendor delay.\n"));
  assert.ok(last.body.includes("### Detail\n\nNested."));
  const appended = patchSection(body, "Owners", "Ana and Ben.");
  assert.equal(appended.action, "appended");
  assert.ok(appended.body.endsWith("## Owners\n\nAna and Ben.\n"));
  assert.ok(appended.body.includes("## Risks\n\nNone yet."));
  // A heading inside a code fence is text, not a section.
  const fenced = "## Notes\n\n```md\n## Timeline\n```\n\n## Timeline\n\nReal.\n";
  const fencedPatch = patchSection(fenced, "Timeline", "Changed.");
  assert.ok(fencedPatch.body.includes("```md\n## Timeline\n```"));
  assert.ok(fencedPatch.body.endsWith("## Timeline\n\nChanged.\n"));
  assert.deepEqual(listSections(fenced), [{ level: 2, heading: "Notes" }, { level: 2, heading: "Timeline" }]);
  assert.throws(() => patchSection(body, "", "x"), /which section/);
});

test("the no-secrets check names what it saw and lets ordinary text through", () => {
  assert.equal(findSecretLike("Ship the plan by Friday; budget is $12,000."), "");
  assert.match(findSecretLike("key: sk-proj-abcdefghijklmnopqrstuvwxyz1234"), /an API key/);
  assert.match(findSecretLike("-----BEGIN RSA PRIVATE KEY-----"), /private key/);
  assert.match(findSecretLike("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12"), /GitHub token/);
  assert.match(findSecretLike("password: hunter2hunter2hunter2"), /password or secret value/);
  assert.match(findSecretLike("AKIAABCDEFGHIJKLMNOP"), /AWS/);
  assert.equal(findSecretLike("The token bucket algorithm limits requests."), "");
});

test("create, update by body or section, revisions, restore, and the always-loaded index", async () => {
  const dir = await home();
  let now = 1_700_000_000_000;
  const created = await createDocument(dir, SLUG, {
    title: "Launch plan",
    summary: "Ship onboarding by the end of Q3.",
    highlights: ["Three phases", "Two owners", "Risk: vendor delay"],
    body: "# Launch plan\n\n## Timeline\n\nWeek one: research.\n\n## Owners\n\nAna and Ben.\n",
  }, { now });
  assert.equal(created.id, "launch-plan");
  assert.equal(created.revision, 1);
  assert.equal(created.status, "active");
  // The frontmatter title owns the heading; the body does not repeat it.
  assert.equal(created.body, "## Timeline\n\nWeek one: research.\n\n## Owners\n\nAna and Ben.\n");
  const onDisk = await readFile(path.join(dir, SLUG, "documents", "launch-plan.md"), "utf8");
  assert.match(onDisk, /^---\nid: launch-plan\n/);
  const index = await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8");
  assert.ok(index.includes("- launch-plan — Launch plan — Ship onboarding by the end of Q3."), index);
  assert.ok(!index.includes("(none yet)"));

  // Same title again gets a distinct id.
  const twin = await createDocument(dir, SLUG, { title: "Launch plan", summary: "Another." }, { now: now + 1 });
  assert.equal(twin.id, "launch-plan-2");

  now += 60_000;
  const patched = await updateDocument(dir, SLUG, "launch-plan", {
    summary: "Ship onboarding by mid-Q3.",
    patch: { heading: "Timeline", content: "Week one: research.\nWeek two: build." },
  }, { now });
  assert.equal(patched.revision, 2);
  assert.equal(patched.section, "Timeline");
  assert.equal(patched.sectionAction, "replaced");
  assert.equal(patched.changed, true);
  assert.equal(patched.body, "## Timeline\n\nWeek one: research.\nWeek two: build.\n\n## Owners\n\nAna and Ben.\n");
  assert.equal(patched.summary, "Ship onboarding by mid-Q3.");
  assert.deepEqual(patched.highlights, ["Three phases", "Two owners", "Risk: vendor delay"]);

  // Nothing changed → no new revision, no history entry.
  const same = await updateDocument(dir, SLUG, "launch-plan", { patch: { heading: "Timeline", content: "Week one: research.\nWeek two: build." } }, { now: now + 1 });
  assert.equal(same.changed, false);
  assert.equal(same.revision, 2);

  for (let step = 0; step < 6; step += 1) {
    now += 60_000;
    await updateDocument(dir, SLUG, "launch-plan", { body: `## Timeline\n\nStep ${step}.\n` }, { now });
  }
  const current = await readDocument(dir, SLUG, "launch-plan");
  assert.equal(current.revision, 8);
  const revisions = await listRevisions(dir, SLUG, "launch-plan");
  assert.equal(revisions.length, HISTORY_LIMIT);
  assert.deepEqual(revisions.map((entry) => entry.revision), [7, 6, 5, 4, 3]);
  assert.deepEqual(await readdir(path.join(dir, SLUG, "documents", ".history", "launch-plan")).then((names) => names.sort()), ["3.md", "4.md", "5.md", "6.md", "7.md"]);

  now += 60_000;
  const restored = await restoreRevision(dir, SLUG, "launch-plan", 4, { now });
  assert.equal(restored.revision, 9);
  assert.equal(restored.updatedBy, "person");
  assert.equal(restored.body, "## Timeline\n\nStep 1.\n");
  const afterRestore = await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8");
  assert.ok(afterRestore.includes("edited by the person — ask before rewriting it"), afterRestore);
  await assert.rejects(restoreRevision(dir, SLUG, "launch-plan", 1), /not in the history/);

  const listed = await listDocuments(dir, SLUG);
  assert.deepEqual(listed.map((document) => document.id), ["launch-plan", "launch-plan-2"]);
  assert.equal(listed[0].words, 4);
  assert.equal("body" in listed[0], false);
  // No temp files linger after atomic writes.
  const names = await readdir(path.join(dir, SLUG, "documents"));
  assert.ok(names.every((name) => !name.endsWith(".tmp")), names.join(","));
});

test("context_set puts documents aside and back, reports unknown ids, and leaves archived ones to the person", async () => {
  const dir = await home();
  for (const title of ["Alpha", "Beta", "Gamma"]) await createDocument(dir, SLUG, { title, summary: `${title} summary` });
  const first = await setContext(dir, SLUG, { active: ["alpha"], aside: ["beta", "missing"] });
  assert.deepEqual(first.changed, [{ id: "beta", title: "Beta", status: "aside" }]);
  assert.deepEqual(first.unknown, ["missing"]);
  assert.equal(first.activeCount, 2);
  assert.equal(first.overTarget, false);
  const index = await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8");
  assert.ok(index.includes("- alpha — Alpha"));
  assert.ok(!index.includes("- beta — Beta"));
  assert.ok(index.includes("Put aside (1): beta."), index);

  await archiveDocument(dir, SLUG, "gamma");
  const second = await setContext(dir, SLUG, { active: ["gamma", "beta"], aside: [] });
  assert.deepEqual(second.skippedArchived, ["gamma"]);
  assert.deepEqual(second.changed, [{ id: "beta", title: "Beta", status: "active" }]);
  await assert.rejects(setContext(dir, SLUG, { active: ["alpha"], aside: ["alpha"] }), /both active and put aside/);
  await assert.rejects(updateDocument(dir, SLUG, "gamma", { body: "x" }), /archived/);
  const back = await setDocumentStatus(dir, SLUG, "gamma", "active");
  assert.equal(back.status, "active");
  for (let index = 0; index < ACTIVE_SET_TARGET; index += 1) await createDocument(dir, SLUG, { title: `Extra ${index}` });
  const crowded = await setContext(dir, SLUG, { active: [], aside: [] });
  assert.equal(crowded.overTarget, true);
});

test("the index renders active lines, the put-aside note, and the style reminder; the log stays bounded", async () => {
  const empty = renderDocumentsIndex([]);
  assert.ok(empty.includes("(none yet)"));
  const rendered = renderDocumentsIndex([
    { id: "a", title: "A", summary: "First.", status: "active", updatedBy: "coworker" },
    { id: "b", title: "B", summary: "", status: "aside", updatedBy: "coworker" },
    { id: "c", title: "C", summary: "Third.", status: "archived", updatedBy: "coworker" },
  ], { reminder: "Keep it short." });
  assert.ok(rendered.includes("- a — A — First."));
  assert.ok(!rendered.includes("- c — C"));
  assert.ok(rendered.includes("Put aside (1): b."));
  assert.ok(rendered.endsWith("## Reminder\n\nKeep it short.\n"));

  const dir = await home();
  await ensureDocumentsHome(dir, SLUG);
  assert.ok((await stat(path.join(dir, SLUG, "documents", "index.md"))).isFile());
  const recorded = await recordStyleEvent(dir, SLUG, { kind: "long-reply", messageId: "msg_1", chars: 1500 }, { now: 5 });
  assert.equal(recorded.recorded, true);
  const again = await recordStyleEvent(dir, SLUG, { kind: "long-reply", messageId: "msg_1", chars: 1500 }, { now: 6 });
  assert.equal(again.recorded, false);
  assert.equal(styleReminder(await readStyleEvents(dir, SLUG)).length > 0, true);
  const withReminder = await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8");
  assert.ok(withReminder.includes("## Reminder"), withReminder);
  await recordStyleEvent(dir, SLUG, { kind: "document" }, { now: 7 });
  assert.equal(styleReminder(await readStyleEvents(dir, SLUG)), "");
  assert.ok(!(await readFile(path.join(dir, SLUG, "documents", "index.md"), "utf8")).includes("## Reminder"));
  for (let index = 0; index < 30; index += 1) await recordStyleEvent(dir, SLUG, { kind: "long-reply", messageId: `m${index}` }, { now: 10 + index });
  assert.equal((await readStyleEvents(dir, SLUG)).length, 20);
});

test("a body that carries a secret is refused with a sentence, on create and on update", async () => {
  const dir = await home();
  await assert.rejects(createDocument(dir, SLUG, { title: "Keys", body: "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh12" }), /GitHub token/);
  await createDocument(dir, SLUG, { title: "Notes", body: "Clean." });
  await assert.rejects(updateDocument(dir, SLUG, "notes", { body: "-----BEGIN PRIVATE KEY-----" }), /private key/);
  assert.equal((await readDocument(dir, SLUG, "notes")).body, "Clean.\n");
  await assert.rejects(createDocument(dir, SLUG, { title: "" }), /needs a title/);
  await assert.rejects(readDocument(dir, SLUG, "nope"), /no document/);
});
