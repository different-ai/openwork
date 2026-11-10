import assert from "node:assert/strict";
import { test } from "node:test";
import { reachSentence } from "./access-summary";

test("Everyone stays everyone while the owner is the only member", () => {
  assert.equal(
    reachSentence({ orgWide: true, memberIds: [], teamIds: [] }, 0, "Notion"),
    "Everyone in the organization will find Notion in My Library.",
  );
});

test("people and teams are counted, and nobody else falls back to the caller's wording", () => {
  assert.equal(reachSentence({ orgWide: false, memberIds: ["m1"], teamIds: [] }, 1, "it"), "1 person will find it in My Library.");
  assert.equal(reachSentence({ orgWide: false, memberIds: [], teamIds: ["t1"] }, 4, "Notion"), "4 people will find Notion in My Library.");
  assert.equal(reachSentence({ orgWide: false, memberIds: ["owner"], teamIds: [] }, 0, "Notion"), null);
});
