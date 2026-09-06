import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_PERSONALITY,
  PERSONALITIES,
  PERSONALITY_OPTIONS,
  WORKING_SAYINGS,
  normalizePersonality,
  previewSayings,
  workingSaying,
} from "./personalities.ts";

test("every personality has an option entry and every non-none personality has a deep, clean set of sayings", () => {
  assert.deepEqual(
    PERSONALITY_OPTIONS.map((option) => option.id),
    [...PERSONALITIES],
    "options and ids stay in the same order",
  );
  for (const personality of PERSONALITIES) {
    if (personality === "none") continue;
    const sayings = WORKING_SAYINGS[personality];
    assert.ok(sayings.length >= 30, `${personality} has ${sayings.length} sayings; want at least 30`);
    assert.equal(new Set(sayings.map((saying) => saying.toLowerCase())).size, sayings.length, `${personality} repeats a saying`);
    for (const saying of sayings) {
      assert.ok(saying.length >= 6 && saying.length <= 56, `${personality}: "${saying}" length ${saying.length}`);
      assert.doesNotMatch(saying, /[.!?…]$/, `${personality}: "${saying}" should not end with punctuation`);
      assert.equal(saying.trim(), saying, `${personality}: "${saying}" has stray whitespace`);
      assert.match(saying, /^[A-Z]/, `${personality}: "${saying}" should start with a capital`);
    }
  }
});

test("unknown or missing personalities fall back to the default; none produces no saying", () => {
  assert.equal(DEFAULT_PERSONALITY, "neutral");
  assert.equal(normalizePersonality(undefined), "neutral");
  assert.equal(normalizePersonality("sarcastic-pirate"), "neutral");
  assert.equal(normalizePersonality("playful"), "playful");
  assert.equal(workingSaying("none", "scout:thread", 3), "");
  assert.deepEqual(previewSayings("none", "scout"), []);
});

test("sayings rotate deterministically without immediate repeats, and differ between coworkers", () => {
  const first = Array.from({ length: 40 }, (_, tick) => workingSaying("meticulous", "scout:t1", tick));
  const again = Array.from({ length: 40 }, (_, tick) => workingSaying("meticulous", "scout:t1", tick));
  assert.deepEqual(first, again, "same seed and tick give the same saying on every surface");
  for (let index = 1; index < first.length; index += 1) {
    assert.notEqual(first[index], first[index - 1], `tick ${index} repeats the previous saying`);
  }
  const cycle = WORKING_SAYINGS.meticulous.length;
  assert.equal(new Set(first.slice(0, cycle)).size, cycle, "one full cycle visits every saying once");

  const other = Array.from({ length: 6 }, (_, tick) => workingSaying("meticulous", "editor:t9", tick));
  assert.notDeepEqual(first.slice(0, 6), other, "two coworkers with the same personality do not speak in unison");
});

test("previews are the first sayings the coworker would actually use", () => {
  const preview = previewSayings("thoughtful", "ops", 3);
  assert.equal(preview.length, 3);
  assert.deepEqual(
    preview,
    [0, 1, 2].map((tick) => workingSaying("thoughtful", "ops", tick)),
  );
});
