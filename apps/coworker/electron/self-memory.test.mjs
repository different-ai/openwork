import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker, listLongTermMemories, readCoworkerFile, restoreCoworker, retireCoworker } from "./coworkers.mjs";
import { AUTOMATIC_MEMORY_CALLS_PER_DAY, createConversationMemory } from "./conversation-memory.mjs";
import {
  CHANGES_FILE,
  CHANGES_LIMIT,
  NOTE_WORK_LIMIT,
  SECRET_REFUSAL,
  WORKING_MEMORY_BULLET_LIMIT,
  applySoulChange,
  forgetFact,
  looksLikeSecret,
  noteProgress,
  parseProgressNote,
  parseSections,
  parseSoul,
  readChanges,
  rememberFact,
  serializeSections,
  undoChange,
  updateSoul,
  writeTrackedFile,
} from "./self-memory.mjs";

const roots = [];
async function fixture(name = "Nova") {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-self-memory-"));
  roots.push(root);
  const coworkersDir = path.join(root, "coworkers");
  const coworker = await createCoworker(coworkersDir, { name, role: "Research partner", mission: "Keep research moving." });
  return { coworkersDir, slug: coworker.slug };
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

test("the soul parses into its four sections and serializes back byte for byte", async () => {
  const { coworkersDir, slug } = await fixture();
  const soul = await readCoworkerFile(coworkersDir, slug, "soul.md");
  const parsed = parseSoul(soul);
  assert.deepEqual(Object.keys(parsed.sections), ["Role", "Mission", "Principles", "Communication"]);
  assert.deepEqual(parsed.sections.Role, { kind: "paragraph", text: "Research partner" });
  assert.deepEqual(parsed.sections.Mission, { kind: "paragraph", text: "Keep research moving." });
  assert.equal(parsed.sections.Principles.items.length, 5);
  assert.deepEqual(parsed.sections.Communication, { kind: "bullets", items: ["Concise, concrete, and honest about uncertainty."] });
  assert.equal(serializeSections(parseSections(soul)), soul);
  const sparse = "# Soul\n\n## Role\n\nHelper\n";
  assert.equal(parseSoul(sparse).sections.Mission, null);
});

test("a soul change edits one section and leaves the others untouched", async () => {
  const { coworkersDir, slug } = await fixture();
  const soul = await readCoworkerFile(coworkersDir, slug, "soul.md");
  const added = applySoulChange(soul, "communication", { kind: "add", text: "Keep replies short." });
  assert.equal(added.summary, 'Updated Communication: added "Keep replies short."');
  const after = parseSoul(added.text);
  assert.deepEqual(after.sections.Communication.items, ["Concise, concrete, and honest about uncertainty.", "Keep replies short."]);
  assert.deepEqual(after.sections.Principles, parseSoul(soul).sections.Principles);
  assert.equal(added.text.split("## Role")[0], soul.split("## Role")[0]);
  // Adding the same line twice keeps one.
  assert.deepEqual(parseSoul(applySoulChange(added.text, "Communication", { kind: "add", text: "Keep replies short" }).text).sections.Communication.items.length, 2);
  const replaced = applySoulChange(added.text, "Principles", { kind: "replace", target: "approval before consequential", text: "Ask before any email to a customer." });
  assert.ok(parseSoul(replaced.text).sections.Principles.items.includes("Ask before any email to a customer."));
  assert.equal(parseSoul(replaced.text).sections.Principles.items.length, 5);
  const removed = applySoulChange(replaced.text, "Principles", { kind: "remove", target: "hypothetical work" });
  assert.equal(parseSoul(removed.text).sections.Principles.items.length, 4);
  assert.equal(removed.summary, 'Updated Principles: removed "hypothetical work"');
  const role = applySoulChange(removed.text, "Role", { kind: "rewrite", text: "Product research partner for J." });
  assert.deepEqual(parseSoul(role.text).sections.Role, { kind: "paragraph", text: "Product research partner for J." });
  const mission = applySoulChange(role.text, "Mission", { kind: "add", text: "Ship the launch brief by Friday." });
  assert.equal(parseSoul(mission.text).sections.Mission.text, "Keep research moving. Ship the launch brief by Friday.");
  const rewritten = applySoulChange(mission.text, "Communication", { kind: "rewrite", text: "Short replies.\nPlain words." });
  assert.deepEqual(parseSoul(rewritten.text).sections.Communication.items, ["Short replies.", "Plain words."]);
  // Still four sections, in order, after everything.
  assert.deepEqual(parseSections(rewritten.text).sections.map((section) => section.name), ["Role", "Mission", "Principles", "Communication"]);
  assert.throws(() => applySoulChange(soul, "Habits", { kind: "add", text: "x" }), /four sections I can change/);
  assert.throws(() => applySoulChange(soul, "Principles", { kind: "remove", target: "nothing like this" }), /couldn't find a line about/);
  assert.throws(() => applySoulChange(soul, "Principles", { kind: "shout", text: "x" }), /one of: add, replace, remove, or rewrite/);
  assert.throws(() => applySoulChange(soul, "Principles", { kind: "add", text: "" }), /Say what to add/);
  // A missing section is appended rather than invented elsewhere.
  const sparse = applySoulChange("# Soul\n\n## Role\n\nHelper\n", "Communication", { kind: "add", text: "Be brief." });
  assert.equal(sparse.text, "# Soul\n\n## Role\n\nHelper\n\n## Communication\n\n- Be brief.\n");
});

test("secrets and credentials are refused everywhere memory is written", async () => {
  assert.equal(looksLikeSecret("You work in Product"), false);
  assert.equal(looksLikeSecret("We use Slack and Linear"), false);
  assert.equal(looksLikeSecret("Call me J"), false);
  assert.equal(looksLikeSecret("The API key is sk-live-1234567890abcdef1234"), true);
  assert.equal(looksLikeSecret("password: hunter2!"), true);
  assert.equal(looksLikeSecret("AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(looksLikeSecret("ghp_abcdefghijklmnopqrstuvwxyz1234"), true);
  assert.equal(looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----"), true);
  assert.equal(looksLikeSecret("card 4111 1111 1111 1111"), true);
  const { coworkersDir, slug } = await fixture();
  await assert.rejects(rememberFact(coworkersDir, slug, { text: "Their password is hunter2", kind: "working" }), new RegExp(SECRET_REFUSAL.slice(0, 30)));
  await assert.rejects(updateSoul(coworkersDir, slug, { section: "Principles", change: { kind: "add", text: "Use token ghp_abcdefghijklmnopqrstuvwxyz1234" } }), /secret or a credential/);
  assert.equal((await readChanges(coworkersDir, slug)).length, 0);
});

test("remembering curates working memory, promotes to long-term memory, and forgets on request", async () => {
  const { coworkersDir, slug } = await fixture();
  const first = await rememberFact(coworkersDir, slug, { text: "The launch brief is due Friday", kind: "working" }, { now: 1 });
  assert.equal(first.output.split("\n")[0], "Remembered in working memory: The launch brief is due Friday");
  const working = await readCoworkerFile(coworkersDir, slug, "memory/working.md");
  assert.match(working, /## Now\n\n- The launch brief is due Friday\n/);
  assert.doesNotMatch(working, /Nothing yet/);
  assert.match(working, /## Carrying forward/);
  // The same fact again is not appended.
  const again = await rememberFact(coworkersDir, slug, { text: "the launch brief is due Friday.", kind: "working" }, { now: 2 });
  assert.equal(again.output, "Already in working memory: the launch brief is due Friday.");
  assert.equal(again.change, null);
  // Long-term facts go into a topic file that is listed in the index.
  const durable = await rememberFact(coworkersDir, slug, { text: "You work in Product", kind: "long-term", topic: "About you" }, { now: 3 });
  assert.equal(durable.output, "Remembered in long-term memory (About you): You work in Product");
  const memories = await listLongTermMemories(coworkersDir, slug);
  assert.deepEqual(memories.map((memory) => [memory.file, memory.title, memory.indexed]), [["about-you.md", "About you", true]]);
  assert.equal(await readCoworkerFile(coworkersDir, slug, "memory/long-term/about-you.md"), "# About you\n\n- You work in Product\n");
  const more = await rememberFact(coworkersDir, slug, { text: "You like to be called J", kind: "long-term", topic: "About you" }, { now: 4 });
  assert.equal(more.output, "Remembered in long-term memory (About you): You like to be called J");
  assert.equal(await readCoworkerFile(coworkersDir, slug, "memory/long-term/about-you.md"), "# About you\n\n- You work in Product\n- You like to be called J\n");
  // A working-memory fact promoted to long-term memory leaves working memory.
  const moved = await rememberFact(coworkersDir, slug, { text: "The launch brief is due Friday", kind: "long-term", topic: "Launch" }, { now: 5 });
  assert.match(moved.output, /^Moved to long-term memory \(Launch\): The launch brief is due Friday\nIt is no longer in working memory\./);
  assert.doesNotMatch(await readCoworkerFile(coworkersDir, slug, "memory/working.md"), /launch brief/);
  assert.match(await readCoworkerFile(coworkersDir, slug, "memory/index.md"), /- `long-term\/launch\.md` — Launch/);
  // Forgetting: a working line, a line inside a memory, then a whole memory.
  await rememberFact(coworkersDir, slug, { text: "Draft is in the shared folder", kind: "working" }, { now: 6 });
  const forgot = await forgetFact(coworkersDir, slug, { target: "draft is in the shared folder" }, { now: 7 });
  assert.equal(forgot.output, "Forgot from working memory: Draft is in the shared folder");
  const forgotLine = await forgetFact(coworkersDir, slug, { target: "called J" }, { now: 8 });
  assert.equal(forgotLine.output, 'Forgot from the long-term memory "About you": You like to be called J');
  const forgotAll = await forgetFact(coworkersDir, slug, { target: "Launch" }, { now: 9 });
  assert.equal(forgotAll.output, 'Forgot the long-term memory "Launch" and its line in the index.');
  assert.equal(await exists(path.join(coworkersDir, slug, "memory/long-term/launch.md")), false);
  assert.doesNotMatch(await readCoworkerFile(coworkersDir, slug, "memory/index.md"), /launch/);
  await assert.rejects(forgetFact(coworkersDir, slug, { target: "the moon" }), /couldn't find anything in memory about "the moon"/);
  await assert.rejects(rememberFact(coworkersDir, slug, { text: "x", kind: "somewhere" }), /two places/);
  await assert.rejects(rememberFact(coworkersDir, slug, { text: "  ", kind: "working" }), /Say what to remember/);
});

test("a progress note keeps one line per piece of work: set, replaced in place, cleared, and read back as its own kind", async () => {
  const { coworkersDir, slug } = await fixture();
  await rememberFact(coworkersDir, slug, { text: "The launch brief is due Friday", kind: "working" }, { now: 1 });
  const started = await noteProgress(coworkersDir, slug, { work: "Vendor comparison", text: "Comparing three vendors on price and support; next: read the contracts." }, { now: 2 });
  assert.equal(started.output.split("\n")[0], "Noted for Vendor comparison: Comparing three vendors on price and support; next: read the contracts.");
  assert.equal(started.previous, null);
  assert.equal(started.change.tool, "memory_note");
  assert.deepEqual(started.change.input, { work: "Vendor comparison", text: "Comparing three vendors on price and support; next: read the contracts." });
  let working = await readCoworkerFile(coworkersDir, slug, "memory/working.md");
  assert.match(working, /## Now\n\n- The launch brief is due Friday\n- \*\*Vendor comparison\*\* — Comparing three vendors on price and support; next: read the contracts\.\n/);
  // A second note for the same work replaces the line where it stands, whatever the casing or a trailing full stop,
  // and the line keeps the name the work was first given.
  const later = await noteProgress(coworkersDir, slug, { work: "vendor comparison.", text: "Two contracts read; Acme is cheapest but has no SLA. Next: call Beta." }, { now: 3 });
  assert.equal(later.previous.text, "Comparing three vendors on price and support; next: read the contracts.");
  assert.match(later.output, /^Noted for Vendor comparison: Two contracts read/);
  working = await readCoworkerFile(coworkersDir, slug, "memory/working.md");
  assert.match(working, /- The launch brief is due Friday\n- \*\*Vendor comparison\*\* — Two contracts read; Acme is cheapest but has no SLA\. Next: call Beta\.\n/);
  assert.equal((working.match(/\*\*vendor comparison\*\*/gi) ?? []).length, 1);
  assert.deepEqual(parseProgressNote("**Vendor comparison** — Two contracts read"), { work: "Vendor comparison", text: "Two contracts read" });
  assert.equal(parseProgressNote("The launch brief is due Friday"), null);
  // The same state again changes nothing and records nothing.
  const same = await noteProgress(coworkersDir, slug, { work: "Vendor comparison", text: "Two contracts read; Acme is cheapest but has no SLA. Next: call Beta" }, { now: 4 });
  assert.equal(same.change, null);
  assert.match(same.output, /^Already noted for Vendor comparison/);
  // Notes for different work sit side by side; an ordinary fact with the same words is left alone.
  await noteProgress(coworkersDir, slug, { work: "Launch plan", text: "Drafting phase two." }, { now: 5 });
  working = await readCoworkerFile(coworkersDir, slug, "memory/working.md");
  assert.equal(working.match(/^- /gm).length, 4); // the fact, two notes, and the Carrying forward placeholder
  // Clearing removes only that line; clearing again is a no-op that says so.
  const cleared = await noteProgress(coworkersDir, slug, { work: "Vendor comparison", text: "" }, { now: 6 });
  assert.equal(cleared.output.split("\n")[0], "Cleared the note for Vendor comparison");
  assert.equal(cleared.previous.text, "Two contracts read; Acme is cheapest but has no SLA. Next: call Beta.");
  working = await readCoworkerFile(coworkersDir, slug, "memory/working.md");
  assert.doesNotMatch(working, /Vendor comparison/i);
  assert.match(working, /- The launch brief is due Friday\n- \*\*Launch plan\*\* — Drafting phase two\.\n/);
  const nothing = await noteProgress(coworkersDir, slug, { work: "Vendor comparison" }, { now: 7 });
  assert.equal(nothing.change, null);
  assert.equal(nothing.output, "No note to clear for Vendor comparison.");
  // The changes list shows the notes in the same words and undo restores the previous line.
  const changes = await readChanges(coworkersDir, slug);
  assert.deepEqual(changes.map((change) => [change.at, change.tool, change.output]), [
    [6, "memory_note", "Cleared the note for Vendor comparison"],
    [5, "memory_note", "Noted for Launch plan: Drafting phase two."],
    [3, "memory_note", "Noted for Vendor comparison: Two contracts read; Acme is cheapest but has no SLA. Next: call Beta."],
    [2, "memory_note", "Noted for Vendor comparison: Comparing three vendors on price and support; next: read the contracts."],
    [1, "memory_remember", "Remembered in working memory: The launch brief is due Friday"],
  ]);
  await undoChange(coworkersDir, slug, changes[0].id, { now: 8 });
  assert.match(await readCoworkerFile(coworkersDir, slug, "memory/working.md"), /\*\*Vendor comparison\*\* — Two contracts read/);
  // forget still works on a note, by its work name.
  const forgot = await forgetFact(coworkersDir, slug, { target: "vendor comparison" }, { now: 9 });
  assert.match(forgot.output, /^Forgot from working memory: \*\*Vendor comparison\*\*/);
  // Guardrails: the work needs a name, the line stays bounded, and secrets are refused.
  await assert.rejects(noteProgress(coworkersDir, slug, { work: "  ", text: "x" }), /Say which piece of work/);
  await assert.rejects(noteProgress(coworkersDir, slug, { work: "w".repeat(NOTE_WORK_LIMIT + 1), text: "x" }), /under 80 characters/);
  await assert.rejects(noteProgress(coworkersDir, slug, { work: "Long", text: "x".repeat(600) }), /under 600 characters/);
  await assert.rejects(noteProgress(coworkersDir, slug, { work: "Keys", text: "the api key is sk-live-1234567890abcdef1234" }), new RegExp(SECRET_REFUSAL.slice(0, 20)));
  assert.doesNotMatch(await readCoworkerFile(coworkersDir, slug, "memory/working.md"), /sk-live/);
});

test("a progress note respects the working-memory cap for new work but can still update or clear existing work", async () => {
  const { coworkersDir, slug } = await fixture();
  await noteProgress(coworkersDir, slug, { work: "Vendor comparison", text: "Started." }, { now: 0 });
  for (let index = 1; index < WORKING_MEMORY_BULLET_LIMIT; index += 1) {
    await rememberFact(coworkersDir, slug, { text: `Item ${index}`, kind: "working" }, { now: index });
  }
  await assert.rejects(noteProgress(coworkersDir, slug, { work: "Another job", text: "Started." }), /already holds 30 items/);
  const updated = await noteProgress(coworkersDir, slug, { work: "Vendor comparison", text: "Halfway." }, { now: 100 });
  assert.match(updated.output, /^Noted for Vendor comparison: Halfway\./);
  const cleared = await noteProgress(coworkersDir, slug, { work: "Vendor comparison", text: "" }, { now: 101 });
  assert.match(cleared.output, /^Cleared the note for Vendor comparison\nWorking memory now holds 29 items\./);
});

test("working memory stays small: past the limit the coworker is told to curate", async () => {
  const { coworkersDir, slug } = await fixture();
  for (let index = 0; index < WORKING_MEMORY_BULLET_LIMIT; index += 1) {
    await rememberFact(coworkersDir, slug, { text: `Item ${index}`, kind: "working" }, { now: index });
  }
  await assert.rejects(rememberFact(coworkersDir, slug, { text: "One more", kind: "working" }), /already holds 30 items/);
});

test("every change is logged with before and after, newest first, and can be undone as a change of its own", async () => {
  const { coworkersDir, slug } = await fixture();
  const soulBefore = await readCoworkerFile(coworkersDir, slug, "soul.md");
  const updated = await updateSoul(coworkersDir, slug, { section: "Communication", change: { kind: "add", text: "Keep replies short." } }, { now: 10 });
  assert.equal(updated.output, 'Updated Communication: added "Keep replies short."');
  await rememberFact(coworkersDir, slug, { text: "You work in Product", kind: "long-term", topic: "About you" }, { now: 20 });
  await writeTrackedFile(coworkersDir, slug, "memory/working.md", "# Working memory — Nova\n\n## Now\n\n- Edited by hand\n", { now: 30 });
  const changes = await readChanges(coworkersDir, slug);
  assert.deepEqual(changes.map((change) => [change.at, change.actor, change.tool, change.undone]), [
    [30, "person", "edit", false],
    [20, "coworker", "memory_remember", false],
    [10, "coworker", "soul_update", false],
  ]);
  assert.deepEqual(changes[2].input, { section: "Communication", change: { kind: "add", text: "Keep replies short.", target: "" } });
  assert.equal(changes[2].output, 'Updated Communication: added "Keep replies short."');
  assert.deepEqual(changes[2].files.map((file) => file.path), ["soul.md"]);
  // Excerpts show what changed, not the whole file.
  assert.equal(changes[2].files[0].after, "- Keep replies short.");
  assert.equal(changes[2].files[0].before, "");
  assert.deepEqual(changes[1].files.map((file) => file.path).sort(), ["memory/index.md", "memory/long-term/about-you.md"]);
  assert.equal(changes[1].files.find((file) => file.path.endsWith("about-you.md")).before, null);
  // Undo restores the soul; the undo is itself in the list and the original reads as undone.
  const undo = await undoChange(coworkersDir, slug, changes[2].id, { now: 40 });
  assert.equal(undo.tool, "undo");
  assert.equal(undo.undoes, changes[2].id);
  assert.equal(await readCoworkerFile(coworkersDir, slug, "soul.md"), soulBefore);
  const afterUndo = await readChanges(coworkersDir, slug);
  assert.deepEqual(afterUndo.map((change) => [change.tool, change.undone, change.undoes]), [
    ["undo", false, changes[2].id],
    ["edit", false, null],
    ["memory_remember", false, null],
    ["soul_update", true, null],
  ]);
  await assert.rejects(undoChange(coworkersDir, slug, changes[2].id), /already undone/);
  await assert.rejects(undoChange(coworkersDir, slug, "nope"), /no longer in the list/);
  // Undoing the long-term memory removes the created file and its index line together.
  await undoChange(coworkersDir, slug, changes[1].id, { now: 50 });
  assert.equal(await exists(path.join(coworkersDir, slug, "memory/long-term/about-you.md")), false);
  assert.doesNotMatch(await readCoworkerFile(coworkersDir, slug, "memory/index.md"), /about-you/);
  // Undoing an undo brings the soul change back.
  await undoChange(coworkersDir, slug, undo.id, { now: 60 });
  assert.match(await readCoworkerFile(coworkersDir, slug, "soul.md"), /Keep replies short/);
  // The log is one JSON object per line on disk and stays bounded.
  const raw = await readFile(path.join(coworkersDir, slug, CHANGES_FILE), "utf8");
  assert.equal(raw.trim().split("\n").length, 6);
  for (let index = 0; index < CHANGES_LIMIT + 5; index += 1) {
    await writeTrackedFile(coworkersDir, slug, "memory/working.md", `# Working memory\n\n## Now\n\n- Edit ${index}\n`, { now: 100 + index });
  }
  assert.equal((await readFile(path.join(coworkersDir, slug, CHANGES_FILE), "utf8")).trim().split("\n").length, CHANGES_LIMIT);
  assert.equal((await readChanges(coworkersDir, slug, { limit: 5 })).length, 5);
});

const memoryModel = {
  id: "fixture/small", providerId: "fixture", modelId: "small", cost: { input: 0.1, output: 0.2 },
  progressEligibility: { transport: "openai", knownPrice: true, nonReasoning: true, text: true, active: true },
};
const privateMemoryOwner = { kind: "private", slug: "scout", conversationId: "one" };
const memoryEntry = (id, endedAt, patch = {}) => ({ id, endedAt, state: "succeeded", owner: privateMemoryOwner, requestText: "Budget is 42 EUR.", result: "I will draft the estimate.", ...patch });

test("automatic memory persists exact safe excerpts, isolates scopes, checks current group membership, and keeps clear tombstones", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  await mkdir(path.join(directory, "editor"));
  let clock = 1000;
  let member = true;
  const options = { directory, now: () => clock, groupsFor: async () => member ? ["team"] : [], ready: async () => { throw new Error("Capture must not warm models."); } };
  const memory = createConversationMemory(options);
  const first = memoryEntry("first", clock);
  for (const state of [undefined, "running", "failed", "cancelled"]) {
    assert.equal(await memory.capture({ ...first, state }), false);
  }
  assert.equal((await memory.read(privateMemoryOwner)).recent.length, 0);
  assert.equal(await memory.capture(first), true);
  assert.equal(await memory.capture(first), false);
  assert.equal((await memory.read(privateMemoryOwner)).recent.length, 2);
  assert.match(await memory.context({ ...privateMemoryOwner, conversationId: "another-thread" }), /42 EUR/);
  assert.equal(await memory.context({ ...privateMemoryOwner, slug: "editor" }), "");
  assert.equal(await memory.context({ ...privateMemoryOwner, kind: "worker" }), "");
  const group = { kind: "group", slug: "scout", groupId: "team" };
  await memory.capture(memoryEntry("group", ++clock, { owner: group, requestText: "Team target is 73 units.", prompt: "NEVER STORE THIS WRAPPER", result: "Shared reply." }));
  assert.match(await memory.context({ ...privateMemoryOwner, slug: "editor" }), /73 units/);
  assert.doesNotMatch(await memory.context(group), /42 EUR|NEVER STORE/);
  assert.equal((await memory.read({ ...group, slug: "editor" })).recent.length, 2);
  member = false;
  assert.equal(await memory.read(group), null);
  assert.equal(await memory.context(group), "");
  assert.doesNotMatch(await memory.context(privateMemoryOwner), /73 units/);
  await memory.capture(memoryEntry("secret", ++clock, { requestText: `${"innocent ".repeat(150)}password: hunter2`, result: "The safe reply has 19 items." }));
  const saved = await memory.read(privateMemoryOwner);
  assert.equal(saved.recent.some((message) => message.sourceId === "secret" && message.speaker === "user"), false);
  assert.match(await memory.context(privateMemoryOwner), /19 items/);
  const storeFile = path.join(directory, "scout", ".conversation-memory.json");
  assert.equal((await stat(storeFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(storeFile, "utf8")).recent.length, saved.recent.length);
  await memory.clear(privateMemoryOwner);
  assert.equal((await memory.read(privateMemoryOwner)).storeId, saved.storeId);
  await memory.stop();
  const restarted = createConversationMemory(options);
  assert.equal(await restarted.capture(first), false);
  assert.equal(await restarted.context(privateMemoryOwner), "");
  assert.equal(await restarted.capture(memoryEntry("fresh", ++clock)), true);
  restarted.configure({ automaticMemoryEnabled: false });
  assert.equal(await restarted.capture(memoryEntry("disabled", ++clock)), false);
  assert.equal(await restarted.context(privateMemoryOwner), "");
  assert.equal(await restarted.read(privateMemoryOwner), null);
  assert.equal(await restarted.clear(privateMemoryOwner), true);
  await restarted.stop();
});

test("automatic memory validates evidence, merges duplicates, and preserves captures arriving during extraction", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  let clock = 1000;
  let release;
  let began;
  let calls = 0;
  const started = new Promise((resolve) => { began = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  const memory = createConversationMemory({ directory, now: () => clock, ready: async () => ({ models: [memoryModel], client: {} }),
    extract: async (_client, _model, { prompt }) => {
      assert.ok(Buffer.byteLength(prompt) <= 16_000);
      calls++;
      if (calls === 1) { began(); return response; }
      return JSON.stringify({ shortTerm: [{ text: "budget is 42 eur", evidence: "42 EUR" }], longTerm: [] });
    } });
  await memory.capture(memoryEntry("first", clock));
  const pending = memory.tick();
  await started;
  await memory.capture(memoryEntry("second", ++clock, { requestText: "Next amount is 84 EUR." }));
  release(JSON.stringify({ shortTerm: [{ text: "Budget is 42 EUR.", evidence: "42 EUR" }], longTerm: [{ text: "Always draft estimates.", evidence: "draft the estimate" }] }));
  await pending;
  let store = await memory.read(privateMemoryOwner);
  assert.equal(store.recent.length, 4);
  assert.equal(store.shortTerm.length, 1);
  assert.equal(store.longTerm.length, 0, "an assistant assertion is not durable user evidence");
  assert.equal(store.shortTerm[0].sources[0].sourceId, "first");
  await memory.tick();
  assert.equal(calls, 1, "per-scope cooldown applies to queued captures");
  clock += 15_000;
  await memory.capture(memoryEntry("third", clock));
  await memory.tick();
  store = await memory.read(privateMemoryOwner);
  assert.equal(store.shortTerm.length, 1);
  assert.deepEqual(store.shortTerm[0].sources.map((source) => source.sourceId), ["first", "third"]);
  assert.equal(store.recent.length, 6);
  assert.ok((await memory.context(privateMemoryOwner)).length <= 8000);
  for (let index = 0; index < 8; index++) {
    await memory.capture(memoryEntry(`bounded-${index}`, ++clock, { requestText: `Current figure ${index} is 99.50 EUR. ${"\u754c".repeat(1200)}`, result: "Evidence ".repeat(300) }));
  }
  clock += 15_000;
  await memory.tick();
  store = await memory.read(privateMemoryOwner);
  assert.equal(store.recent.length, 12);
  assert.ok(store.recent.every((message) => message.text.length <= 800));
  assert.match(await memory.context(privateMemoryOwner), /Current figure 7 is 99\.50 EUR/);
  assert.ok((await memory.context(privateMemoryOwner)).length <= 8000);
  await memory.stop();
});

test("automatic memory discards late extraction after clear or settings changes and stop drains captures", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  let clock = 1000;
  let release;
  let began;
  let requestSignal;
  let started;
  const memory = createConversationMemory({ directory, now: () => clock, ready: async () => ({ models: [memoryModel], client: {} }),
    extract: async (_client, _model, { signal }) => {
      requestSignal = signal;
      began();
      return new Promise((resolve) => { release = resolve; });
    } });
  for (const action of ["clear", "disable", "stop"]) {
    clock += 16_000;
    await memory.capture(memoryEntry(action, clock));
    started = new Promise((resolve) => { began = resolve; });
    const pending = memory.tick();
    await started;
    let stopped;
    if (action === "clear") await memory.clear(privateMemoryOwner);
    if (action === "disable") memory.configure({ automaticMemoryEnabled: false });
    if (action === "stop") {
      const captured = memory.capture(memoryEntry("drained", ++clock));
      stopped = memory.stop();
      assert.equal(await captured, true);
    }
    assert.equal(requestSignal.aborted, true);
    release(JSON.stringify({ shortTerm: [{ text: "Budget remembered", evidence: "42 EUR" }], longTerm: [] }));
    await pending;
    await stopped;
    memory.configure({ automaticMemoryEnabled: true });
    assert.deepEqual((await memory.read(privateMemoryOwner)).shortTerm, []);
  }
  const restarted = createConversationMemory({ directory });
  assert.ok((await restarted.read(privateMemoryOwner)).recent.some((message) => message.sourceId === "drained"));
  const before = await memory.read(privateMemoryOwner);
  assert.equal(await memory.capture(memoryEntry("after-stop", ++clock)), false);
  await memory.tick();
  assert.deepEqual(await restarted.read(privateMemoryOwner), before);
  await restarted.stop();
});

test("automatic memory waits for an eligible model without spending and reservations survive uncertain failures and restarts", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  let clock = 1000;
  let models = [];
  let calls = 0;
  const options = { directory, now: () => clock, ready: async () => ({ models, client: {} }),
    extract: async (_client, model) => { calls++; assert.equal(model.id, memoryModel.id); throw new Error("Uncertain delivery"); } };
  let memory = createConversationMemory(options);
  await memory.capture(memoryEntry("waiting", clock));
  await memory.tick();
  assert.equal(calls, 0);
  models = [{ ...memoryModel, id: "fixture/expensive", cost: { input: 0.4, output: 1 } }, memoryModel];
  memory.configure({ memoryModelId: "fixture/missing" });
  await memory.tick();
  assert.equal(calls, 0);
  memory.configure({ memoryModelId: "" });
  await memory.tick();
  assert.equal(calls, 1);
  await memory.stop();
  memory = createConversationMemory(options);
  clock += 16_000;
  await memory.tick();
  assert.equal(calls, 1, "restart cannot replay an uncertain batch");
  for (let index = 1; index <= AUTOMATIC_MEMORY_CALLS_PER_DAY; index++) {
    await mkdir(path.join(directory, `coworker-${index}`));
    await memory.capture(memoryEntry(`scope-${index}`, clock, { owner: { ...privateMemoryOwner, slug: `coworker-${index}` } }));
    await memory.tick();
  }
  assert.equal(calls, AUTOMATIC_MEMORY_CALLS_PER_DAY, "budget is app-wide, not per coworker");
  await memory.stop();
  memory = createConversationMemory(options);
  await memory.tick();
  assert.equal(calls, AUTOMATIC_MEMORY_CALLS_PER_DAY, "restart does not reset the day's budget");
  clock += 86_400_000;
  await memory.tick();
  assert.equal(calls, AUTOMATIC_MEMORY_CALLS_PER_DAY + 1);
  await memory.stop();
});

test("automatic memory rechecks group membership at capture commit and drains only admitted captures on stop", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  let member = true;
  let checks = 0;
  let reachedCommit;
  let releaseCommit;
  const atCommit = new Promise((resolve) => { reachedCommit = resolve; });
  const holdCommit = new Promise((resolve) => { releaseCommit = resolve; });
  const memory = createConversationMemory({ directory, groupsFor: async () => {
    if (++checks === 2) { reachedCommit(); await holdCommit; }
    return member ? ["team"] : [];
  } });
  const owner = { kind: "group", slug: "scout", groupId: "team" };
  const pending = memory.capture(memoryEntry("revoked-before-commit", 1000, { owner }));
  await atCommit;
  member = false;
  const stopped = memory.stop();
  assert.equal(await memory.capture(memoryEntry("during-stop", 1001)), false);
  releaseCommit();
  assert.equal(await pending, false);
  await stopped;
  member = true;
  assert.equal((await memory.read(owner)).recent.length, 0, "a revoked capture was not written while draining");
  assert.equal((await memory.read(privateMemoryOwner)).recent.length, 0);
});

test("automatic memory retains loaded long-term and short-term recall across private and three allowed groups with full recent history", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  let clock = 1000;
  let groupIds = ["alpha", "beta", "gamma"];
  const groupsFor = async () => groupIds;
  const memory = createConversationMemory({ directory, now: () => clock, groupsFor,
    ready: async () => ({ models: [memoryModel], client: {} }),
    extract: async (_client, _model, { prompt }) => {
      const user = JSON.parse(prompt).recent.find((message) => message.speaker === "user");
      assert.match(user.text, /I prefer metric units/);
      return JSON.stringify({
        longTerm: [{ text: "Prefers metric units.", evidence: "I prefer metric units." }, { text: "Prefers concise replies.", evidence: "Keep replies concise." }],
        shortTerm: [{ text: "Draft due 17 September.", evidence: "Draft due 17 September." }],
      });
    } });
  const owners = [privateMemoryOwner, ...groupIds.map((groupId) => ({ kind: "group", slug: "scout", groupId }))];
  for (const owner of owners) {
    const id = owner.groupId ?? "private";
    await memory.capture(memoryEntry(`seed-${id}`, ++clock, { owner, requestText: "I prefer metric units. Keep replies concise. Draft due 17 September." }));
    await memory.tick();
  }
  for (const owner of owners) {
    for (let index = 0; index < 6; index++) {
      await memory.capture(memoryEntry(`fill-${owner.groupId ?? "private"}-${index}`, ++clock, { owner,
        requestText: `Current figure ${index} is 99.50 EUR. ${"More context. ".repeat(100)}`, result: "Latest draft report. ".repeat(100) }));
    }
    assert.equal((await memory.read(owner)).recent.length, 12);
  }
  await memory.stop();
  const loaded = createConversationMemory({ directory, groupsFor });
  const text = await loaded.context(privateMemoryOwner);
  assert.ok(text.length <= 8000);
  const context = JSON.parse(text);
  assert.equal(context.memories.length, 4);
  for (const recalled of context.memories) {
    assert.ok(recalled.recent.length > 0 && recalled.recent.length <= 4);
    assert.ok(recalled.longTermCandidates.some((candidate) => candidate.text === "Prefers metric units."));
    assert.ok(recalled.shortTermCandidates.some((candidate) => candidate.text === "Draft due 17 September."));
    for (const candidate of recalled.longTermCandidates) {
      assert.equal(candidate.speaker, "user");
      assert.equal(candidate.sourceId, `seed-${recalled.owner.groupId ?? "private"}`);
      assert.ok(candidate.evidence.length > 0);
    }
  }
  groupIds = ["alpha", "gamma"];
  assert.equal(JSON.parse(await loaded.context(privateMemoryOwner)).memories.some((item) => item.owner.groupId === "beta"), false);
  assert.equal(await loaded.context(owners[2]), "");
  await loaded.stop();
});

test("automatic memory follows retirement and restore, isolates same-slug replacements, and rejects late model output", async () => {
  const { coworkersDir: directory } = await fixture("Scout");
  let clock = 1000;
  let calls = 0;
  let began;
  let release;
  const started = new Promise((resolve) => { began = resolve; });
  const response = new Promise((resolve) => { release = resolve; });
  const options = { directory, now: () => clock, ready: async () => ({ models: [memoryModel], client: {} }),
    extract: async () => {
      calls++;
      if (calls === 1) { began(); return response; }
      return JSON.stringify({ shortTerm: [], longTerm: [] });
    } };
  const memory = createConversationMemory(options);
  for (const slug of ["../escape", "ScOut", "scout/other", ".retired", "absent"]) {
    const owner = { ...privateMemoryOwner, slug };
    assert.equal(await memory.capture(memoryEntry("invalid-home", clock, { owner })), false);
    assert.equal(await memory.read(owner), null);
    assert.equal(await memory.context(owner), "");
    assert.equal(await memory.clear(owner), false);
  }
  assert.equal(await exists(path.join(directory, "absent")), false);
  await symlink(path.join(directory, "scout"), path.join(directory, "alias"));
  assert.equal(await memory.capture(memoryEntry("symlink-home", clock, { owner: { ...privateMemoryOwner, slug: "alias" } })), false);
  assert.equal(await memory.read({ ...privateMemoryOwner, slug: "alias" }), null);

  await memory.capture(memoryEntry("original", clock));
  const original = await memory.read(privateMemoryOwner);
  const pending = memory.tick();
  await started;
  const retired = await retireCoworker(directory, "scout", { now: clock });
  assert.equal(await memory.context(privateMemoryOwner), "");
  assert.equal(await memory.capture(memoryEntry("missing-home", ++clock)), false);
  assert.equal(await memory.clear(privateMemoryOwner), false);
  assert.equal(await exists(path.join(directory, "scout")), false, "memory cannot recreate a retired home");
  assert.deepEqual(JSON.parse(await readFile(path.join(retired.path, ".conversation-memory.json"), "utf8")), original);

  const replacement = await createCoworker(directory, { name: "Scout", role: "New partner", mission: "Start fresh." });
  assert.equal(replacement.slug, "scout");
  assert.equal(await memory.context(privateMemoryOwner), "");
  await memory.capture(memoryEntry("replacement", ++clock, { requestText: "New budget is 99 EUR." }));
  const fresh = await memory.read(privateMemoryOwner);
  assert.notEqual(fresh.storeId, original.storeId);
  release(JSON.stringify({ shortTerm: [{ text: "Old budget is 42 EUR.", evidence: "42 EUR" }], longTerm: [] }));
  await pending;
  assert.deepEqual(await memory.read(privateMemoryOwner), fresh, "late output cannot modify the replacement store");
  await memory.tick();
  assert.equal(calls, 2, "a replacement's sequence one has its own reservation and cooldown");
  const central = path.join(directory, ".conversation-memory");
  const budgetName = `${createHash("sha256").update("budget").digest("hex")}.json`;
  assert.deepEqual(await readdir(central), [budgetName], "private stores never live in the central directory");
  const ledger = JSON.parse(await readFile(path.join(central, budgetName), "utf8"));
  assert.equal(ledger.calls, 2, "replacing a coworker does not reset the app-wide budget");
  assert.equal(Object.keys(ledger.reservations).length, 2);
  await memory.clear(privateMemoryOwner);
  assert.equal((await memory.read(privateMemoryOwner)).storeId, fresh.storeId);
  await memory.capture(memoryEntry("replacement-pending", ++clock));
  const retiredReplacement = await retireCoworker(directory, "scout", { now: clock + 1000 });
  await restoreCoworker(directory, retired.archiveId);
  assert.deepEqual(await memory.read(privateMemoryOwner), original, "restore brings back the original store unchanged");
  assert.equal(JSON.parse(await readFile(path.join(retiredReplacement.path, ".conversation-memory.json"), "utf8")).storeId, fresh.storeId);
  clock += 16_000;
  await memory.capture(memoryEntry("restored-pending", clock));
  await memory.stop();

  const restarted = createConversationMemory(options);
  await restarted.tick();
  assert.equal(calls, 3, "restart discovers pending memory inside a current coworker home");
  await restarted.tick();
  assert.equal(calls, 3, "discovery excludes retired homes and symlinks");
  assert.equal((await restarted.read(privateMemoryOwner)).storeId, original.storeId);
  assert.match(await restarted.context(privateMemoryOwner), /42 EUR/);
  assert.doesNotMatch(await restarted.context(privateMemoryOwner), /99 EUR|replacement/);
  await restarted.stop();
});
