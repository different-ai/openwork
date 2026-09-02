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

test("assignmentPrompt drops tool-only and system turns and keeps the outcome as the source of truth", () => {
  const prompt = assignmentPrompt("Summarize the week.", [
    { role: "system", text: "hidden system text" },
    { role: "assistant", text: "" },
    { role: "user", text: "How was the week?" },
  ]);
  assert.doesNotMatch(prompt, /hidden system text/);
  assert.match(prompt, /You: How was the week\?/);
  assert.match(prompt, /treat the outcome above as the source of truth/);
});
