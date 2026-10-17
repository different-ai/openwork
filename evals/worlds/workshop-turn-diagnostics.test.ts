import test from "node:test";
import assert from "node:assert/strict";
import { workshopTurnDiagnostic, workshopTurnTerminal } from "./workshop-turn-diagnostics.ts";

test("diagnostics locate a pending local tool/question without retaining content or secrets", () => {
  const messages = [{ info: { id: "message", role: "assistant", sessionID: "session", providerID: "provider", modelID: "model", agent: "openwork", time: { created: 1 } }, parts: [{ id: "part", type: "tool", tool: "question", callID: "call", state: { status: "running", input: { question: "PRIVATE-PROMPT", token: "PRIVATE-CREDENTIAL" }, output: "PRIVATE-OUTPUT", error: { name: "ToolError", message: "PRIVATE-ERROR" }, time: { start: 2 } } }, { type: "text", text: "PRIVATE-TEXT" }] }];
  const snapshot = workshopTurnDiagnostic({ sessionId: "session", messages, statuses: { session: { type: "busy" } }, permissions: [{ id: "permission", sessionID: "other", patterns: ["PRIVATE-PATTERN"] }], questions: [{ id: "question", sessionID: "session", questions: ["PRIVATE-QUESTION"], tool: { callID: "call" } }] });
  assert.equal(snapshot.messages[0].parts[0].tool, "question");
  assert.equal(snapshot.messages[0].parts[0].status, "running");
  assert.equal(snapshot.pendingQuestions[0].callId, "call");
  assert.deepEqual(snapshot.pendingPermissions, []);
  assert.equal(snapshot.status.type, "busy");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE-/);
  assert.equal(workshopTurnTerminal(messages, new Set()), false);
});

test("normal completion and abort remain distinguishable from an unfinished or old turn", () => {
  const message = { info: { id: "new", role: "assistant", finish: "stop", time: { completed: 3 } }, parts: [] };
  assert.equal(workshopTurnTerminal([message], new Set()), true);
  assert.equal(workshopTurnTerminal([message], new Set(["new"])), false);
  const incomplete = { info: { ...message.info, finish: "tool-calls" }, parts: [] };
  assert.equal(workshopTurnTerminal([incomplete], new Set()), false);
  const aborted = { info: { role: "assistant", error: { name: "MessageAbortedError", message: "PRIVATE-ERROR" } }, parts: [] };
  assert.equal(workshopTurnTerminal([aborted], new Set()), true);
  const snapshot = workshopTurnDiagnostic({ sessionId: "session", messages: [aborted], statuses: {}, permissions: [], questions: [] });
  assert.equal(snapshot.messages[0].errorCode, "MessageAbortedError");
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE-ERROR/);
});
