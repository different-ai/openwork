import assert from "node:assert/strict";
import { test } from "node:test";
import { assignmentPrompt, parseAssignmentBrief } from "./conversation.ts";

test("assignmentPrompt carries bounded visible discussion into an explicit outcome", () => {
  const messages = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `visible message ${index} ${"x".repeat(1_500)}`,
    reasoning: "hidden reasoning must not be copied",
    toolCalls: [{
      partId: "prt_secret",
      tool: "read",
      status: "completed",
      input: { filePath: "/Users/me/secret-input.md" },
      output: "TOOL OUTPUT PAYLOAD",
      error: null,
      metadata: { openworkMcpApp: { content: [{ type: "text", text: "MCP APP PAYLOAD" }] } },
    }],
  }));
  const prompt = assignmentPrompt("Ship the revised launch brief.", messages);
  assert.match(prompt, /## Outcome\n\nShip the revised launch brief\./);
  assert.doesNotMatch(prompt, /visible message [01] /, "only the eight most recent messages are carried");
  assert.match(prompt, /You: visible message 2 /);
  assert.match(prompt, /Coworker: visible message 9 /);
  assert.doesNotMatch(prompt, /hidden reasoning/);
  for (const payload of ["prt_secret", "secret-input", "TOOL OUTPUT PAYLOAD", "MCP APP PAYLOAD", "openworkMcpApp"]) {
    assert.doesNotMatch(prompt, new RegExp(payload), `tool payload ${payload} must not become assignment context`);
  }
  assert.ok(prompt.length < 7_000, `assignment prompt stayed bounded, got ${prompt.length} characters`);
});

test("parseAssignmentBrief reads back the outcome and carried discussion, and nothing else", () => {
  const messages = [
    { role: "user", text: "Can you draft the launch note?\n\nKeep it short." },
    { role: "assistant", text: "Yes — I would lead with the date.\nThen the two changes." },
    { role: "system", text: "hidden system text" },
    { role: "assistant", text: "" },
  ];
  const prompt = assignmentPrompt("Write the launch note by Friday", messages);
  assert.doesNotMatch(prompt, /hidden system text/);
  const brief = parseAssignmentBrief(prompt);
  assert.ok(brief);
  assert.equal(brief.outcome, "Write the launch note by Friday");
  assert.deepEqual(brief.context, [
    { speaker: "you", text: "Can you draft the launch note?\n\nKeep it short." },
    { speaker: "coworker", text: "Yes — I would lead with the date.\nThen the two changes." },
  ]);
  const bare = parseAssignmentBrief(assignmentPrompt("Just do it", []));
  assert.deepEqual(bare, { outcome: "Just do it", context: [] });
  assert.equal(parseAssignmentBrief("Reply with exactly CHAT ONE READY."), null);
  assert.equal(parseAssignmentBrief("This is an explicit assignment created from our ongoing discussion.\n\nno headings"), null);
});
