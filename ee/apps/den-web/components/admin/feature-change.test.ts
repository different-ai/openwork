import assert from "node:assert/strict";
import { test } from "node:test";
import { describeFeatureChange, parseFeatureChange } from "./feature-change";

const at = "2026-10-26T14:03:00.000Z";
const omar = { id: "usr_omar", name: "Omar McAdam", email: "omar@example.com" };

test("a change reads as what happened, who did it and when", () => {
  const change = parseFeatureChange({ scope: "organization", action: "on", at, by: omar });
  assert.ok(change);
  const time = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
  assert.equal(describeFeatureChange(change, { locale: "en-GB" }), `On by Omar McAdam · ${time}`);
  assert.equal(describeFeatureChange(change, { locale: "en-GB", showScope: true }), `On for this organization by Omar McAdam · ${time}`);
});

test("resets, kill switches and changes without a person read plainly", () => {
  const reset = parseFeatureChange({ scope: "member", action: "reset", at, by: { ...omar, name: " " } });
  assert.ok(reset);
  assert.match(describeFeatureChange(reset, { showScope: true }), /^Reset to the organization setting by omar@example\.com · /);
  const killed = parseFeatureChange({ scope: "everyone", action: "killed", at, by: null });
  assert.ok(killed);
  assert.match(describeFeatureChange(killed), /^Turned off everywhere · /);
});

test("malformed changes are ignored", () => {
  assert.equal(parseFeatureChange(null), null);
  assert.equal(parseFeatureChange({ scope: "organization", action: "on", at: "yesterday", by: null }), null);
  assert.equal(parseFeatureChange({ scope: "team", action: "on", at, by: null }), null);
  assert.equal(parseFeatureChange({ scope: "organization", action: "toggled", at, by: null }), null);
  assert.deepEqual(parseFeatureChange({ scope: "organization", action: "off", at, by: { id: 1 } }), { scope: "organization", action: "off", at, by: null });
});
