export type RoleAssignmentOutcome = {
  id: string;
  name: string;
  beforeRoleId: string | null;
  status: "pending" | "assigned" | "failed" | "unconfirmed" | "review";
  error?: string;
  currentRoleName?: string;
};

/** Transport cancellation/timeouts and server errors do not prove no write happened. */
export function roleWriteFailureStatus(httpStatus: number | undefined): "failed" | "unconfirmed" {
  return httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408 && httpStatus !== 499 ? "failed" : "unconfirmed";
}

export function canRetryRoleAssignment(outcome: RoleAssignmentOutcome): boolean {
  return outcome.status === "failed";
}

/** A read may confirm completion, but an old/different role never proves an unknown write stopped. */
export function reconcileRoleAssignment(outcome: RoleAssignmentOutcome, currentRoleId: string | null, currentRoleName: string, requestedRoleId: string): RoleAssignmentOutcome {
  if (currentRoleId === requestedRoleId) return { ...outcome, status: "assigned", error: undefined, currentRoleName };
  if (outcome.status === "unconfirmed") return { ...outcome, currentRoleName };
  if (currentRoleId !== outcome.beforeRoleId) return { ...outcome, status: "review", currentRoleName };
  return { ...outcome, currentRoleName };
}
