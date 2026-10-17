import assert from "node:assert/strict";
import test from "node:test";
import { canScheduleWorkflow } from "./workflow-run-access.ts";

test("manual viewer execution never grants scheduling access", () => {
  assert.equal(canScheduleWorkflow("viewer"), false);
  assert.equal(canScheduleWorkflow("editor"), true);
  assert.equal(canScheduleWorkflow("manager"), true);
  for (const role of [null, undefined, "owner", "admin", "", {}, true]) assert.equal(canScheduleWorkflow(role), false);
});
