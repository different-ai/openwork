import assert from "node:assert/strict";
import { test } from "node:test";
import { FEATURE_KEYS, FEATURES } from "@openwork/features";
import { featureAuthors, filterFeatureKeys, NO_FEATURE_SETTINGS_FILTER } from "./admin-organization-feature-controls";

/** The admin organization Features list can be narrowed to one author and to when a feature was added. */

const DAY_MS = 24 * 60 * 60 * 1000;
const newest = [...FEATURE_KEYS].sort((a, b) => FEATURES[b].added.localeCompare(FEATURES[a].added))[0];
const now = Date.parse(`${FEATURES[newest].added}T00:00:00.000Z`) + 3 * DAY_MS;
const ageInDays = (key: (typeof FEATURE_KEYS)[number]) => (now - Date.parse(`${FEATURES[key].added}T00:00:00.000Z`)) / DAY_MS;

test("no filter keeps every feature in order", () => {
  assert.deepEqual(filterFeatureKeys(FEATURE_KEYS, NO_FEATURE_SETTINGS_FILTER, now), [...FEATURE_KEYS]);
});

test("an author filter keeps only that author's features", () => {
  const { author, count } = featureAuthors(FEATURE_KEYS)[0];
  const kept = filterFeatureKeys(FEATURE_KEYS, { author, added: "any" }, now);
  assert.equal(kept.length, count);
  assert.ok(kept.every((key) => FEATURES[key].author === author));
});

test("author counts add up to the features listed", () => {
  assert.equal(featureAuthors(FEATURE_KEYS).reduce((total, { count }) => total + count, 0), FEATURE_KEYS.length);
});

test("a date window keeps features added inside it, and older is the rest of 90 days", () => {
  const week = filterFeatureKeys(FEATURE_KEYS, { author: null, added: "7" }, now);
  assert.ok(week.includes(newest));
  assert.ok(week.every((key) => ageInDays(key) < 7));
  const recent = filterFeatureKeys(FEATURE_KEYS, { author: null, added: "90" }, now);
  const older = filterFeatureKeys(FEATURE_KEYS, { author: null, added: "older" }, now);
  assert.equal(recent.length + older.length, FEATURE_KEYS.length);
  assert.ok(older.every((key) => ageInDays(key) >= 90));
});

test("author and date apply together", () => {
  const author = FEATURES[newest].author;
  const kept = filterFeatureKeys(FEATURE_KEYS, { author, added: "7" }, now);
  assert.ok(kept.includes(newest));
  assert.ok(kept.every((key) => FEATURES[key].author === author && ageInDays(key) < 7));
});
