import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addToMemoryIndex,
  humanizeMemoryFileName,
  isMemoryFileName,
  memoryFileNameFor,
  memoryTitle,
  parseIndexLine,
  parseMemoryIndex,
  removeFromMemoryIndex,
} from "./memory-index.mjs";

const INDEX = `# Long-term memory index

One line per durable memory in \`memory/long-term/\`. Loaded every turn so I
know what I can recall; the files themselves are read only when relevant.

- \`long-term/cleaning-day.md\` — Street cleaning: move car every Friday
- memory/long-term/people.md: Who is who on the team
* [Architecture](long-term/architecture.md) – Decisions that stick
3. \`notes.md\` - Loose notes
`;

test("index bullets are parsed however the coworker wrote the file reference", () => {
  assert.deepEqual(parseMemoryIndex(INDEX).map(({ file, summary }) => ({ file, summary })), [
    { file: "cleaning-day.md", summary: "Street cleaning: move car every Friday" },
    { file: "people.md", summary: "Who is who on the team" },
    { file: "architecture.md", summary: "Architecture – Decisions that stick" },
    { file: "notes.md", summary: "Loose notes" },
  ]);
});

test("prose and bullets without a memory file are not entries", () => {
  assert.equal(parseIndexLine("One line per durable memory in `memory/long-term/`."), null);
  assert.equal(parseIndexLine("- Remember to be kind"), null);
  assert.equal(parseIndexLine("(none yet)"), null);
  assert.equal(parseIndexLine("- `../secrets.md` — never"), null);
});

test("removing a memory drops only its bullet and restores the placeholder when the list empties", () => {
  const without = removeFromMemoryIndex(INDEX, "people.md");
  assert.ok(!without.includes("people.md"));
  assert.ok(without.includes("cleaning-day.md"));
  assert.ok(without.startsWith("# Long-term memory index\n\nOne line per durable memory"));
  assert.equal(removeFromMemoryIndex(INDEX, "missing.md"), INDEX, "unknown files leave the text alone");

  let text = INDEX;
  for (const file of ["cleaning-day.md", "people.md", "architecture.md", "notes.md"]) text = removeFromMemoryIndex(text, file);
  assert.equal(parseMemoryIndex(text).length, 0);
  assert.ok(text.includes("(none yet)"));
});

test("adding a memory replaces the placeholder, then appends after the last entry", () => {
  const empty = `# Long-term memory index\n\nOne line per durable memory.\n\n(none yet)\n`;
  const one = addToMemoryIndex(empty, "cleaning-day.md", "Street cleaning: move car every Friday");
  assert.ok(!one.includes("(none yet)"));
  assert.deepEqual(parseMemoryIndex(one).map((entry) => entry.file), ["cleaning-day.md"]);
  const two = addToMemoryIndex(one, "people.md", "");
  assert.deepEqual(parseMemoryIndex(two).map((entry) => entry.summary), ["Street cleaning: move car every Friday", "People"]);
  assert.equal(addToMemoryIndex(two, "people.md", "again"), two, "an indexed file is not listed twice");
  const bare = addToMemoryIndex("# Index\n", "notes.md", "Loose notes");
  assert.equal(bare, "# Index\n\n- `long-term/notes.md` — Loose notes\n");
});

test("titles come from the first heading and fall back to the file name", () => {
  assert.equal(memoryTitle("# Street cleaning\n\n- Move the car", "cleaning-day.md"), "Street cleaning");
  assert.equal(memoryTitle("\n\n## People ##\n", "people.md"), "People");
  assert.equal(memoryTitle("Just a paragraph\n# Not first", "team_notes.md"), "Team notes");
  assert.equal(humanizeMemoryFileName("q3-plan.md"), "Q3 plan");
});

test("new memory file names are safe slugs", () => {
  assert.equal(memoryFileNameFor("Street cleaning: move the car!"), "street-cleaning-move-the-car.md");
  assert.equal(memoryFileNameFor("Café décisions"), "cafe-decisions.md");
  assert.equal(memoryFileNameFor("   "), "memory.md");
  assert.ok(isMemoryFileName("cleaning-day.md"));
  assert.ok(!isMemoryFileName("long-term/cleaning-day.md"));
  assert.ok(!isMemoryFileName(".hidden.md"));
  assert.ok(!isMemoryFileName("notes.txt"));
});
