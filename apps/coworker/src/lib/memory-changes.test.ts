import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryChange } from "./bridge.ts";
import { describeMemoryChange, describeMemoryFile } from "./memory-changes.ts";

function change(partial: Partial<MemoryChange> & Pick<MemoryChange, "id" | "actor" | "tool">): MemoryChange {
  return { at: 0, input: {}, output: "", files: [], undoes: null, undone: false, ...partial };
}

test("memory files are named the way the Memory view names them", () => {
  assert.equal(describeMemoryFile("soul.md"), "the soul");
  assert.equal(describeMemoryFile("memory/working.md"), "working memory");
  assert.equal(describeMemoryFile("memory/index.md"), "the memory index");
  assert.equal(describeMemoryFile("memory/long-term/cleaning-day.md"), "the memory cleaning-day");
});

test("recent changes read as action words for the coworker, the person, and an undo", () => {
  const remembered = change({ id: "a", actor: "coworker", tool: "memory_remember", input: { text: "You work in Product", kind: "long-term", topic: "About you" }, output: "Remembered in long-term memory (About you): You work in Product" });
  const soul = change({ id: "b", actor: "coworker", tool: "soul_update", input: { section: "Communication", change: { kind: "add", text: "Shorter replies" } }, output: 'Updated Communication: added "Shorter replies"' });
  const edited = change({ id: "c", actor: "person", tool: "edit", files: [{ path: "soul.md", before: "", after: "- x" }] });
  const created = change({ id: "d", actor: "person", tool: "memory_create", input: { title: "Street cleaning" } });
  const deleted = change({ id: "e", actor: "person", tool: "memory_delete", input: { file: "cleaning-day.md" } });
  const undo = change({ id: "f", actor: "undo", tool: "undo", undoes: "b" });
  const orphanUndo = change({ id: "g", actor: "undo", tool: "undo", undoes: "zzz" });
  const all = [orphanUndo, undo, deleted, created, edited, soul, remembered];
  assert.equal(describeMemoryChange(remembered, all), "Remembered · You work in Product");
  assert.equal(describeMemoryChange(soul, all), "Updated how I work · Shorter replies");
  assert.equal(describeMemoryChange(edited, all), "You edited the soul");
  assert.equal(describeMemoryChange(created, all), "You created a memory · Street cleaning");
  assert.equal(describeMemoryChange(deleted, all), "You deleted a memory · cleaning-day");
  assert.equal(describeMemoryChange(undo, all), "Undid · Updated how I work · Shorter replies");
  assert.equal(describeMemoryChange(orphanUndo, all), "Undid an earlier change");
  assert.equal(describeMemoryChange(change({ id: "h", actor: "coworker", tool: "mystery", files: [{ path: "memory/working.md", before: "", after: "" }] }), all), "Changed working memory");
  for (const entry of all) assert.doesNotMatch(describeMemoryChange(entry, all), /coworker_|\{|"kind"/);
});
