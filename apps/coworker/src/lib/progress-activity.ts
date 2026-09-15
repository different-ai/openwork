import { createHeadlessThreadClientV2 } from "@openwork/headless-threads/v2";
import { PROGRESS_LIMITS } from "./progress-config.ts";
import { executionMetadata, executionTimestamp, type ExecutionMetadataInput } from "./work-receipt.ts";
import type { ProgressNote, ProgressObservation } from "./progress-service.ts";

export type ExecutionActivity = {
  executionId: string;
  messageId: string;
  threadId: string;
  slug: string;
  state: "queued" | "running" | "waiting-person" | "succeeded" | "failed" | "cancelled";
  timelineEventId?: string;
  startedAt: number | null;
  completedAt: number | null;
  continuation: boolean;
  retryLabel?: string;
  failure?: string;
  pendingCoworkers: number;
  pendingWorkers: number;
  available: boolean;
  nativeStatus: "busy" | "idle" | "retry" | "unknown";
  replies: Array<{ id: string; parentId: string; parts: Array<{ id: string; text: string; ended?: boolean }> }>;
  tools: Array<ExecutionMetadataInput & { partId: string }>;
  completedSteps: number;
  failedSteps: number;
  progressNote?: ProgressNote;
};

/** Reads only. No setup, model choice, admission, or native cancellation. */
export async function readExecutionActivity(input: {
  serverUrl: string;
  workspaceId: string;
  token: string;
  threadId: string;
  messageId: string;
  signal: AbortSignal;
}): Promise<Pick<ExecutionActivity, "replies" | "tools" | "completedSteps" | "failedSteps" | "nativeStatus">> {
  const client = createHeadlessThreadClientV2({
    baseUrl: input.serverUrl,
    workspaceId: input.workspaceId,
    token: input.token,
  });
  // The shared projection verifies the complete native admission interval;
  // v2 events and assistant messages do not carry a trustworthy parent ID.
  const snapshot = await client.getThreadSnapshot(input.threadId, { signal: input.signal });
  if (snapshot.native?.ambiguousTurns.includes(input.messageId)
    || (!snapshot.messages.some((message) => message.role === "user" && message.id === input.messageId) && !snapshot.native?.pendingInputIds.includes(input.messageId))) {
    throw new Error("Activity attribution could not be verified.");
  }
  const replies: ExecutionActivity["replies"] = [];
  const tools: ExecutionActivity["tools"] = [];
  let remainingChars = PROGRESS_LIMITS.maxReplyChars;
  let remainingParts = PROGRESS_LIMITS.maxReplyParts;
  let completedSteps = 0;
  let failedSteps = 0;
  for (const message of snapshot.messages) {
    if (message.role !== "assistant" || message.parentId !== input.messageId) continue;
    const parts: ExecutionActivity["replies"][number]["parts"] = [];
    for (const part of message.parts) {
      if (part.type === "text" && !part.synthetic && !part.ignored && remainingParts > 0 && remainingChars > 0) {
        const text = (part.text ?? "").slice(0, remainingChars);
        parts.push({ id: part.id, text, ended: message.completedAt !== null || message.error !== null });
        remainingChars -= text.length;
        remainingParts--;
      }
      if (part.type === "tool") {
        const metadata = executionMetadata({
          tool: part.tool ?? "",
          status: part.toolStatus === "streaming" ? "pending" : part.toolStatus ?? "unknown",
          startedAt: executionTimestamp(part.toolStartedAt),
          completedAt: executionTimestamp(part.toolCompletedAt),
        });
        if (metadata.status === "completed") completedSteps++;
        if (metadata.status === "failed") failedSteps++;
        // Canonical categories only cross this boundary, never provider names or payloads.
        tools.push({ partId: part.id, tool: metadata.kind, status: metadata.status, startedAt: metadata.startedAt, completedAt: metadata.completedAt });
      }
    }
    if (replies.length < PROGRESS_LIMITS.maxReplyParts) replies.push({ id: message.id, parentId: input.messageId, parts });
  }
  return { replies, tools: tools.slice(-PROGRESS_LIMITS.maxVisibleSteps), completedSteps, failedSteps, nativeStatus: snapshot.status.type };
}

export function executionProgress(activity: ExecutionActivity, hasText = false): ProgressObservation {
  const tool = activity.tools.findLast((call) => call.status === "running" || call.status === "pending") ?? null;
  return {
    executionId: activity.executionId,
    status: activity.state === "succeeded" ? "completed" : activity.state === "failed" ? "failed" : activity.state === "cancelled" ? "cancelled" : activity.state === "waiting-person" ? "waiting" : activity.state === "queued" ? "sending" : !activity.available || activity.nativeStatus === "unknown" ? "unknown" : activity.nativeStatus === "retry" ? "retrying" : activity.nativeStatus === "idle" ? "waiting" : tool ? "tool" : hasText ? "streaming" : activity.continuation ? "resuming" : "preparing",
    startedAt: activity.startedAt,
    completedAt: activity.completedAt,
    tool,
    ...(activity.available ? { completedSteps: activity.completedSteps, failedSteps: activity.failedSteps } : {}),
    pendingCoworkers: activity.pendingCoworkers,
    pendingWorkers: activity.pendingWorkers,
    note: activity.progressNote,
  };
}
