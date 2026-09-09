import assert from "node:assert/strict";
import { test } from "node:test";
import { freshStartLine, freshStartLines, resetConfirmation } from "./fresh-start.ts";

test("DELETE reactions advance with the exact prefix and reverse with backspace", () => {
  const typing = ["", "D", "DE", "DEL", "DELE", "DELET", "DELETE"];
  assert.deepEqual(typing.map((value) => resetConfirmation(value).progress), [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1]);
  assert.deepEqual([...typing].reverse().map((value) => resetConfirmation(value).progress), [1, 5 / 6, 4 / 6, 3 / 6, 2 / 6, 1 / 6, 0]);
  assert.equal(resetConfirmation("DEwrong").progress, 2 / 6);
});

test("only exact case-sensitive DELETE permits the separate erase action", () => {
  assert.equal(resetConfirmation("DELETE").confirmed, true);
  for (const value of ["", "DELET", "delete", "Delete", " DELETE", "DELETE ", "DELETE\n", "DELETE!", "D\u0395LETE"]) {
    assert.equal(resetConfirmation(value).confirmed, false, JSON.stringify(value));
  }
});

test("team lines use only fixed catalog roles and a stable slug fallback", () => {
  assert.equal(freshStartLine({ roleId: "research", slug: "scout" }), "Wait! I had one more footnote...");
  assert.equal(freshStartLine({ roleId: "operations", slug: "ops" }), "But I just alphabetized everything!");
  assert.equal(freshStartLine({ roleId: "developer", slug: "dev" }), "But it finally works on my machine!");
  assert.equal(freshStartLine({ roleId: "", slug: "custom" }), freshStartLine({ roleId: "unknown", slug: "custom" }));
  assert.equal(typeof freshStartLine({ roleId: "toString", slug: "custom" }), "string");
  const cast = ["atlas", "juniper", "piper"].map((slug) => ({ roleId: "", slug }));
  assert.equal(new Set(freshStartLines(cast)).size, cast.length);
});
