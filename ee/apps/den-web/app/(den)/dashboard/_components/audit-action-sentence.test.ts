import assert from "node:assert/strict";
import { test } from "node:test";
import { auditActionSentence } from "./audit-logs-details";

test("audit requests do not claim that a read completed", () => {
  assert.equal(auditActionSentence("audit.operations.requested"), "requested audit operations read");
  assert.equal(auditActionSentence("audit.operations.attempted"), "attempted audit operations read");
});

test("unknown mutation attempts retain neutral wording rather than becoming reads", () => {
  for (const action of ["auth.oauth.token.issue.attempted", "oauth_client.register.attempted"]) {
    const sentence = auditActionSentence(action);
    assert.ok(sentence.startsWith("recorded "));
    assert.ok(!sentence.includes("view"));
    assert.ok(sentence.includes("attempted"));
  }
});

test("known mutation verbs keep the attempted and completed states distinct", () => {
  assert.equal(auditActionSentence("plugin.create.attempted"), "attempted to create plugin");
  assert.equal(auditActionSentence("plugin.create.succeeded"), "created plugin");
  assert.equal(auditActionSentence("plugin.delete.denied"), "was denied permission to delete plugin");
});
