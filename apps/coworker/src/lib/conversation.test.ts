import assert from "node:assert/strict";
import { test } from "node:test";
import { assignmentPrompt, assignmentTitle, discussionTitle } from "./conversation.ts";

test("discussionTitle and assignmentTitle stay readable and within native session limits", () => {
  assert.equal(discussionTitle(" Scout "), "Discussion with Scout");
  assert.equal(assignmentTitle("  Prepare   the launch brief  "), "Prepare the launch brief");
  assert.equal(assignmentTitle("x".repeat(90)).length, 80);
});

test("assignmentPrompt carries bounded visible discussion into an explicit outcome", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `visible message ${index} ${"x".repeat(1_500)}`,
    reasoning: "hidden reasoning must not be copied",
  }));
  const prompt = assignmentPrompt("Ship the revised launch brief.", messages);
  assert.match(prompt, /## Outcome\n\nShip the revised launch brief\./);
  assert.doesNotMatch(prompt, /visible message [01] /, "only the eight most recent messages are carried");
  assert.match(prompt, /You: visible message 2 /);
  assert.match(prompt, /Coworker: visible message 9 /);
  assert.doesNotMatch(prompt, /hidden reasoning/);
  assert.ok(prompt.length < 7_000, `assignment prompt stayed bounded, got ${prompt.length} characters`);
});
