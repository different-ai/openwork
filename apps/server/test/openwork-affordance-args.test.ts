import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionAffordanceArgsSchemas, sessionQuestionAnswerArgsSchema, sessionReadArgsSchema } from "../src/opencode-plugins/openwork-provider-adapters.js";
import { sessionGroupMoveArgsSchema } from "../src/opencode-plugins/openwork-session-groups.js";

const messages = (result: { success: boolean; error?: { issues: Array<{ message: string }> } }) => result.error?.issues.map((issue) => issue.message) ?? [];

test("session.read refuses `limit` and names `count`, the argument that sets how many messages come back", () => {
  const result = sessionReadArgsSchema.safeParse({ sessionId: "ses_1", limit: 100 });
  assert.equal(result.success, false);
  assert.deepEqual(messages(result), ['Unknown argument "limit". Valid arguments: sessionId, workspaceId, count, from, summary.']);
  assert.equal(sessionReadArgsSchema.safeParse({ sessionId: "ses_1", count: 100, from: "start" }).success, true);
});

test("an answer's argument list includes the fields it adds, not only the ones it shares with list", () => {
  const result = sessionQuestionAnswerArgsSchema.safeParse({ sessionId: "s2", requestId: "q1", answers: [["Yes"]], reveal: true });
  assert.deepEqual(messages(result), ['Unknown argument "reveal". Valid arguments: sessionId, workspaceId, requestId, answers.']);
});

test("every session affordance and sidebar-group command refuses names it does not define", () => {
  for (const [id, schema] of [...Object.entries(sessionAffordanceArgsSchemas), ["session.group.move", sessionGroupMoveArgsSchema] as const]) {
    const result = schema.safeParse({ notAnArgument: true });
    assert.ok(messages(result).some((message) => message.includes('"notAnArgument"')), `${id}: ${JSON.stringify(messages(result))}`);
  }
});
