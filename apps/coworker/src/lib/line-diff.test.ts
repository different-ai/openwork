import assert from "node:assert/strict";
import { test } from "node:test";
import { describeDiff, lineDiff, sideBySide } from "./line-diff.ts";

test("a line diff keeps common lines, marks additions and removals, and reads back as both sides", () => {
  const before = "## Timeline\n\nWeek one.\n\n## Owners\n\nAna.\n";
  const after = "## Timeline\n\nWeek one.\nWeek two.\n\n## Owners\n\nAna and Ben.\n";
  const diff = lineDiff(before, after);
  assert.deepEqual(diff, [
    { kind: "same", text: "## Timeline" },
    { kind: "same", text: "" },
    { kind: "same", text: "Week one." },
    { kind: "added", text: "Week two." },
    { kind: "same", text: "" },
    { kind: "same", text: "## Owners" },
    { kind: "same", text: "" },
    { kind: "removed", text: "Ana." },
    { kind: "added", text: "Ana and Ben." },
  ]);
  assert.equal(diff.filter((line) => line.kind !== "added").map((line) => line.text).join("\n"), before.replace(/\n$/, ""));
  assert.equal(diff.filter((line) => line.kind !== "removed").map((line) => line.text).join("\n"), after.replace(/\n$/, ""));
  assert.equal(describeDiff(diff), "+2 −1 lines");
  assert.equal(describeDiff(lineDiff("a\n", "a\n")), "No changes");
  assert.equal(describeDiff(lineDiff("", "one\n")), "+1 line");
  assert.deepEqual(lineDiff("", ""), []);
  assert.deepEqual(lineDiff("gone\n", ""), [{ kind: "removed", text: "gone" }]);
  assert.deepEqual(lineDiff("a\r\nb\r\n", "a\nb\n"), [{ kind: "same", text: "a" }, { kind: "same", text: "b" }]);
});

test("side by side aligns a removed line with what replaced it and leaves blanks otherwise", () => {
  const rows = sideBySide(lineDiff("a\nb\nc\n", "a\nB\nC\nd\n"));
  assert.deepEqual(rows, [
    { left: { kind: "same", text: "a" }, right: { kind: "same", text: "a" } },
    { left: { kind: "removed", text: "b" }, right: { kind: "added", text: "B" } },
    { left: { kind: "removed", text: "c" }, right: { kind: "added", text: "C" } },
    { left: null, right: { kind: "added", text: "d" } },
  ]);
});

test("a very long document degrades to a plain replace instead of stalling", () => {
  const long = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n");
  const started = Date.now();
  const diff = lineDiff(long, `${long}\nextra`);
  assert.ok(Date.now() - started < 500);
  assert.equal(diff.filter((line) => line.kind === "removed").length, 5_000);
  assert.equal(diff.filter((line) => line.kind === "added").length, 5_001);
});
