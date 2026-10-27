export type WorkflowAccessRole = "viewer" | "editor" | "manager";

/** Manual execution and scheduled execution have different existing server gates. */
export function canScheduleWorkflow(role: unknown): boolean {
  return role === "editor" || role === "manager";
}
