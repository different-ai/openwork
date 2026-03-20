import assert from "node:assert/strict";
import { normalizeLocalFilePath } from "../src/app/lib/local-file-path.impl.js";

const equals = (input, expected) => {
  assert.equal(normalizeLocalFilePath(input), expected, `normalizeLocalFilePath(${input})`);
};

equals(" notes/todo.md ", "notes/todo.md");
equals("file:///tmp/notes.md", "/tmp/notes.md");
equals("file:/tmp/notes.md", "/tmp/notes.md");
equals("file:///C:/Users/xj/note.md", "C:/Users/xj/note.md");
equals("file://server/share/note.md", "//server/share/note.md");
equals("file://localhost/tmp/notes.md", "/tmp/notes.md");
equals("FILE:///tmp/notes.md", "/tmp/notes.md");

assert.doesNotThrow(() => normalizeLocalFilePath("file:///tmp/100%/note.md"));
equals("file:///tmp/100%/note.md", "/tmp/100%/note.md");
assert.doesNotThrow(() => normalizeLocalFilePath("file://%zz"));
equals("file://%zz", "%zz");

console.log(JSON.stringify({ ok: true, checks: 11 }));
