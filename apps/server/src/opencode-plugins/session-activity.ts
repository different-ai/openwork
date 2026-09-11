import { z } from "zod";

const engineSessionStatusesSchema = z.record(z.string(), z.object({ type: z.string() }).passthrough());
const enginePendingRequestsSchema = z.array(z.object({ sessionID: z.string() }).passthrough());

/** Engine vocabulary; `working` is the cross-surface contract agents key decisions on. */
export type SessionActivity = { status: "idle" | "busy" | "retry" | "waiting"; working: boolean };

/**
 * Live activity for one session from the engine: its run status plus any
 * unanswered permission or question addressed to it. An unreadable probe
 * reports working=true with status "busy" so a caller never archives on a
 * guess.
 */
export function sessionActivityFrom(
  statuses: unknown,
  permissions: unknown,
  questions: unknown,
  sessionId: string,
): SessionActivity {
  const parsedStatuses = engineSessionStatusesSchema.safeParse(statuses);
  const parsedPermissions = enginePendingRequestsSchema.safeParse(permissions);
  const parsedQuestions = enginePendingRequestsSchema.safeParse(questions);
  if (!parsedStatuses.success || !parsedPermissions.success || !parsedQuestions.success) {
    return { status: "busy", working: true };
  }
  const waiting = [...parsedPermissions.data, ...parsedQuestions.data].some((request) => request.sessionID === sessionId);
  if (waiting) return { status: "waiting", working: true };
  const type = parsedStatuses.data[sessionId]?.type;
  if (type === "busy" || type === "running") return { status: "busy", working: true };
  if (type === "retry") return { status: "retry", working: true };
  return { status: "idle", working: false };
}
