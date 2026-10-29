import assert from "node:assert/strict";
import { test } from "node:test";
import { librarySkillsLabel, previewSkillSteps, SKILL_STEPS_PREVIEW_LINES, skillTitle } from "./skill-preview-model";

test("short steps are shown whole", () => {
  const body = "Read the notes.\n\n1. List questions.";
  assert.deepEqual(previewSkillSteps(body), { text: body, truncated: false });
});

test("long steps preview the first lines and say more is hidden", () => {
  const body = Array.from({ length: SKILL_STEPS_PREVIEW_LINES + 4 }, (_, index) => `${index + 1}. Step`).join("\n");
  const preview = previewSkillSteps(body);
  assert.equal(preview.truncated, true);
  assert.equal(preview.text.split("\n").length, SKILL_STEPS_PREVIEW_LINES);
  assert.ok(preview.text.endsWith(`${SKILL_STEPS_PREVIEW_LINES}. Step`));
});

test("the Library disclosure names steps for one skill and counts several", () => {
  assert.equal(librarySkillsLabel(true, 1), "Steps");
  assert.equal(librarySkillsLabel(false, null), "Skills");
  assert.equal(librarySkillsLabel(false, 1), "1 skill");
  assert.equal(librarySkillsLabel(false, 2), "2 skills");
});

test("slug names read as titles", () => {
  assert.equal(skillTitle("plan-a-review"), "Plan a review");
  assert.equal(skillTitle("Already Titled"), "Already Titled");
});
