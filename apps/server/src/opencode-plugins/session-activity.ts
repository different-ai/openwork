import type { OpenworkSessionActivityInventory } from "@openwork/types/openwork-affordance";
import { z } from "zod";

const engineSessionStatusesSchema = z.record(z.string(), z.object({ type: z.string() }).passthrough());
const enginePendingRequestsSchema = z.array(z.object({ sessionID: z.string() }).passthrough());

export type SessionActivity = OpenworkSessionActivityInventory & {
  status: "idle" | "busy" | "retry" | "waiting" | "error" | "compacting" | "thinking" | "responding" | "unknown";
};

export function sessionActivityFrom(
  statuses: unknown,
  permissions: unknown,
  questions: unknown,
  sessionId: string,
  descendantIds: readonly string[] = [],
  unknownDescendants = 0,
): SessionActivity {
  const parsedStatuses = engineSessionStatusesSchema.safeParse(statuses);
  const parsedPermissions = enginePendingRequestsSchema.safeParse(permissions);
  const parsedQuestions = enginePendingRequestsSchema.safeParse(questions);
  const probesComplete = parsedStatuses.success && parsedPermissions.success && parsedQuestions.success;
  const waiting = new Set([
    ...parsedPermissions.success ? parsedPermissions.data.map((request) => request.sessionID) : [],
    ...parsedQuestions.success ? parsedQuestions.data.map((request) => request.sessionID) : [],
  ]);
  const statusFor = (id: string): SessionActivity["status"] => {
    const type = parsedStatuses.success ? parsedStatuses.data[id]?.type : undefined;
    if (type === "error") return "error";
    if (waiting.has(id) || type === "waiting") return "waiting";
    if (type === "busy" || type === "running") return "busy";
    if (type === "retry" || type === "compacting" || type === "thinking" || type === "responding") return type;
    return probesComplete && (type === undefined || type === "idle") ? "idle" : "unknown";
  };
  const descendantActivity = { busy: 0, waiting: 0, unknown: unknownDescendants };
  for (const id of new Set(descendantIds)) {
    if (id === sessionId) continue;
    const status = statusFor(id);
    if (status === "unknown") descendantActivity.unknown += 1;
    else if (status === "waiting") descendantActivity.waiting += 1;
    else if (status !== "idle" && status !== "error") descendantActivity.busy += 1;
  }
  const own = statusFor(sessionId);
  return {
    status: own !== "error" && descendantActivity.waiting > 0 ? "waiting" : own,
    working: own !== "idle" && own !== "error" && own !== "unknown"
      || descendantActivity.busy > 0 || descendantActivity.waiting > 0,
    descendantActivity,
    inventoryComplete: probesComplete && own !== "unknown" && descendantActivity.unknown === 0,
  };
}
