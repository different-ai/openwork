import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { PROGRESS_LIMITS } from "./progress-config.ts";
import { executionMetadata, executionTimestamp, type ExecutionMetadataInput } from "./work-receipt.ts";
import type { ProgressObservation } from "./progress-service.ts";

export type ExecutionActivity = {
  executionId: string;
  messageId: string;
  threadId: string;
  slug: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt: number | null;
  completedAt: number | null;
  continuation: boolean;
  retryLabel?: string;
  failure?: string;
  pendingCoworkers: number;
  pendingWorkers: number;
  available: boolean;
  nativeStatus: "busy" | "idle" | "retry" | "unknown";
  replies: Array<{ id: string; parentId: string; parts: Array<{ id: string; text: string }> }>;
  tools: Array<ExecutionMetadataInput & { partId: string }>;
  completedSteps: number;
  failedSteps: number;
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
  const client = createOpencodeClient({
    baseUrl: `${input.serverUrl}/workspace/${encodeURIComponent(input.workspaceId)}/opencode`,
    headers: { Authorization: `Bearer ${input.token}` },
    redirect: "error",
  });
  const [result, status] = await Promise.all([
    client.session.messages({ sessionID: input.threadId }, { signal: input.signal }),
    client.session.status(undefined, { signal: input.signal }),
  ]);
  if (result.error || !result.data) throw new Error("Activity could not be read.");
  const replies: ExecutionActivity["replies"] = [];
  const tools: ExecutionActivity["tools"] = [];
  let remainingChars = PROGRESS_LIMITS.maxReplyChars;
  let remainingParts = PROGRESS_LIMITS.maxReplyParts;
  let completedSteps = 0;
  let failedSteps = 0;
  for (const message of result.data) {
    if (message.info.role !== "assistant" || message.info.parentID !== input.messageId || message.info.sessionID !== input.threadId) continue;
    const parts: ExecutionActivity["replies"][number]["parts"] = [];
    for (const part of message.parts) {
      if (part.type === "text" && !part.synthetic && !part.ignored && remainingParts > 0 && remainingChars > 0) {
        const text = part.text.slice(0, remainingChars);
        parts.push({ id: part.id, text });
        remainingChars -= text.length;
        remainingParts--;
      }
      if (part.type === "tool") {
        const metadata = executionMetadata({
          tool: part.tool,
          status: part.state.status,
          startedAt: "time" in part.state ? executionTimestamp(part.state.time.start) : null,
          completedAt: "time" in part.state && "end" in part.state.time ? executionTimestamp(part.state.time.end) : null,
        });
        if (metadata.status === "completed") completedSteps++;
        if (metadata.status === "failed") failedSteps++;
        // Canonical categories only cross this boundary, never provider names or payloads.
        tools.push({ partId: part.id, tool: metadata.kind, status: metadata.status, startedAt: metadata.startedAt, completedAt: metadata.completedAt });
      }
    }
    if (replies.length < PROGRESS_LIMITS.maxReplyParts) replies.push({ id: message.info.id, parentId: input.messageId, parts });
  }
  return { replies, tools: tools.slice(-PROGRESS_LIMITS.maxVisibleSteps), completedSteps, failedSteps, nativeStatus: status.error || !status.data ? "unknown" : status.data[input.threadId]?.type ?? "idle" };
}

export function executionProgress(activity: ExecutionActivity, hasText = false): ProgressObservation {
  const tool = activity.tools.findLast((call) => call.status === "running" || call.status === "pending") ?? null;
  return {
    executionId: activity.executionId,
    status: activity.state === "succeeded" ? "completed" : activity.state === "failed" ? "failed" : activity.state === "cancelled" ? "cancelled" : activity.state === "queued" ? "sending" : hasText ? "streaming" : !activity.available || activity.nativeStatus === "unknown" ? "unknown" : activity.nativeStatus === "retry" ? "retrying" : activity.nativeStatus === "idle" ? "waiting" : tool ? "tool" : activity.continuation ? "resuming" : "preparing",
    startedAt: activity.startedAt,
    completedAt: activity.completedAt,
    tool,
    ...(activity.available ? { completedSteps: activity.completedSteps, failedSteps: activity.failedSteps } : {}),
    pendingCoworkers: activity.pendingCoworkers,
    pendingWorkers: activity.pendingWorkers,
  };
}
