export type WorkflowAccessRole = "viewer" | "editor" | "manager";

export function canScheduleWorkflow(role: unknown): boolean {
  return role === "editor" || role === "manager";
}
