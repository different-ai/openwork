import assert from "node:assert/strict";
import { test } from "node:test";
import { canRetryRoleAssignment, reconcileRoleAssignment, roleWriteFailureStatus, type RoleAssignmentOutcome } from "./role-assignment-state";

const unknown: RoleAssignmentOutcome = { id: "team", name: "Editors", beforeRoleId: "previous", status: "unconfirmed" };

test("timeouts, cancellation and server errors stay unconfirmed rather than retryable failures", () => {
  for (const status of [undefined, 408, 499, 500, 502, 503, 504]) assert.equal(roleWriteFailureStatus(status), "unconfirmed");
  for (const status of [400, 401, 403, 404, 409, 422, 429]) assert.equal(roleWriteFailureStatus(status), "failed");
  assert.equal(canRetryRoleAssignment(unknown), false);
});

test("read-only reconciliation never turns an unknown old-state read into permission to replay", () => {
  const old = reconcileRoleAssignment(unknown, "previous", "Previous role", "requested");
  assert.equal(old.status, "unconfirmed");
  assert.equal(canRetryRoleAssignment(old), false);
  const changed = reconcileRoleAssignment(unknown, "different", "Different role", "requested");
  assert.equal(changed.status, "unconfirmed");
  assert.equal(canRetryRoleAssignment(changed), false);
  assert.equal(reconcileRoleAssignment(unknown, "requested", "Requested role", "requested").status, "assigned");
});

test("only a definitive rejection with unchanged verified access can be retried", () => {
  const failed: RoleAssignmentOutcome = { ...unknown, status: "failed" };
  assert.equal(canRetryRoleAssignment(reconcileRoleAssignment(failed, "previous", "Previous role", "requested")), true);
  const changed = reconcileRoleAssignment(failed, "different", "Different role", "requested");
  assert.equal(changed.status, "review");
  assert.equal(canRetryRoleAssignment(changed), false);
});
