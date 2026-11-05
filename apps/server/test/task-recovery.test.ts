import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecoveryRecords } from "../src/task-recovery.js";

const valid = {
  workspaceId: "ws_1", directory: "/tmp/ws", sessionId: "ses_1",
  engine: "v2", phase: "running", userId: "msg_1", shutdown: true,
};

test("records from another schema version are dropped instead of failing startup", () => {
  const legacy = [
    { workspaceId: "ws_1", directory: "/tmp/ws", sessionId: "ses_0", engine: "opencode2", phase: "resuming" },
    { workspaceId: "ws_1", directory: "/tmp/ws", sessionId: "ses_2", engine: "opencode2", phase: "running" },
  ];
  assert.deepEqual(parseRecoveryRecords(JSON.stringify([...legacy, valid])), [valid]);
});

test("valid records round-trip unchanged", () => {
  assert.deepEqual(parseRecoveryRecords(JSON.stringify([valid])), [valid]);
});

test("unreadable or non-list journals start empty", () => {
  assert.deepEqual(parseRecoveryRecords("{not json"), []);
  assert.deepEqual(parseRecoveryRecords(JSON.stringify({ records: [valid] })), []);
});

test("journals over the task limit are truncated rather than rejected", () => {
  const many = Array.from({ length: 1_005 }, (_, index) => ({ ...valid, sessionId: `ses_${index}` }));
  assert.equal(parseRecoveryRecords(JSON.stringify(many)).length, 1_000);
});
