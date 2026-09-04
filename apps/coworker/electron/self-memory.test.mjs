import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createCoworker, listLongTermMemories, readCoworkerFile } from "./coworkers.mjs";
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
  readSelf,
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

test("the coworker can read its own files back, all or one part at a time", async () => {
  const { coworkersDir, slug } = await fixture();
  await rememberFact(coworkersDir, slug, { text: "You work in Product", kind: "long-term", topic: "About you" });
  await rememberFact(coworkersDir, slug, { text: "The brief is due Friday", kind: "working" });
  const everything = (await readSelf(coworkersDir, slug, { what: "everything" })).output;
  assert.match(everything, /## soul\.md/);
  assert.match(everything, /## memory\/working\.md/);
  assert.match(everything, /## memory\/long-term\/about-you\.md\n\n# About you\n\n- You work in Product/);
  const memory = (await readSelf(coworkersDir, slug, { what: "memory" })).output;
  assert.doesNotMatch(memory, /## soul\.md/);
  assert.match(memory, /The brief is due Friday/);
  const soul = (await readSelf(coworkersDir, slug, { what: "soul" })).output;
  assert.match(soul, /## Principles/);
  assert.doesNotMatch(soul, /working\.md/);
  await assert.rejects(readSelf(coworkersDir, slug, { what: "dreams" }), /Ask for "soul"/);
});
