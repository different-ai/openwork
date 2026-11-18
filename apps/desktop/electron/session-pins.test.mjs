import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSessionPins } from "./session-pins.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "session-pins-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "session-pins.v1.json"), journal: createSessionPins(directory) };
}
test("acknowledged pins survive a new store and a malformed primary", t => {
  const { directory, file, journal } = fixture(t);
  assert.equal(journal.read(), null);
  journal.update({ previous: [], next: ["one", "two"] });
  assert.deepEqual(createSessionPins(directory).read(), ["one", "two"]);
  writeFileSync(file, "{broken");
  assert.deepEqual(createSessionPins(directory).read(), ["one", "two"]);
});
test("failed recovery cannot overwrite either journal with defaults", t => {
  const { file, journal } = fixture(t);
  writeFileSync(file, "{broken");
  writeFileSync(`${file}.backup`, "{also-broken");
  assert.throws(() => journal.read(), /could not be recovered/);
  assert.throws(() => journal.update({ previous: [], next: [] }), /could not be recovered/);
  assert.equal(readFileSync(file, "utf8"), "{broken");
  assert.equal(readFileSync(`${file}.backup`, "utf8"), "{also-broken");
});
test("stale sidebar writes do not erase newer pins and explicit unpin still works", t => {
  const { journal } = fixture(t);
  journal.update({ previous: [], next: ["one"] });
  journal.update({ previous: ["one"], next: ["one", "two"] });
  journal.update({ previous: ["one"], next: ["one"] });
  assert.deepEqual(journal.read(), ["one", "two"]);
  journal.update({ previous: ["one", "two"], next: ["two"] });
  assert.deepEqual(journal.read(), ["two"]);
});
test("invalid partial state is rejected without changing the file", t => {
  const { journal } = fixture(t);
  journal.update({ previous: [], next: ["one"] });
  assert.throws(() => journal.update({ previous: [], next: null }), /Invalid session pins/);
  assert.deepEqual(journal.read(), ["one"]);
});
