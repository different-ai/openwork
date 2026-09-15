import { z } from "zod"
import type { RemoteSessionAction } from "../mcp/remote-session-capabilities.js"
import { scopeKey, SlackApiError, type SlackCall } from "./protocol.js"
export const checkpointSchema = z.object({
  phase: z.enum(["create", "send", "read", "finish"]).default("create"),
  channel: z.string().optional(),
  threadTs: z.string().optional(),
  streamTs: z.string().optional(),
  sessionId: z.string().optional(),
  workspaceId: z.string().optional(),
  prompt: z.string().optional(),
  sentText: z.string().default(""),
  steps: z.record(z.string(), z.string()).default({}),
  privateReply: z.boolean().default(false),
  firstTextAt: z.number().optional(),
  completedAt: z.number().optional(),
  streamCharacters: z.number().default(0),
  recipientUserId: z.string().optional(),
  recipientTeamId: z.string().optional(),
  wakeShown: z.boolean().default(false),
  finalStatus: z.enum(["active", "suspended"]).default("active"),
  titleSynced: z.boolean().default(false),
})
type Checkpoint = z.infer<typeof checkpointSchema>
const readSchema = z.object({
  status: z.string(),
  title: z.string().nullable().optional(),
  messageCount: z.number(),
  finalAssistantText: z.string(),
  terminalError: z.unknown().optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      toolCalls: z.array(z.object({ id: z.string(), name: z.string(), status: z.string().nullable() })),
    }),
  ),
})
export type RemoteCall = (
  action: RemoteSessionAction,
  body: Record<string, unknown>,
) => Promise<Record<string, unknown>>
export function webLink(sessionId: string) {
  const url = new URL(
    `/session/${encodeURIComponent(sessionId)}`,
    process.env.DEN_WEB_OPENWORK_WEB_URL ?? "https://web.openworklabs.com",
  )
  return url.toString()
}

export function currentReplyDelta(previous: string, current: string) {
  // A revised answer must not append an unrelated full transcript.
  return current.startsWith(previous) ? current.slice(previous.length) : ""
}
export async function stopSlackStream(slack: SlackCall, checkpoint: Checkpoint, extra: Record<string, unknown> = {}) {
  try {
    await slack("chat.stopStream", {
      channel: checkpoint.channel,
      ts: checkpoint.streamTs,
      session_status: checkpoint.finalStatus,
      ...extra,
    })
  } catch (error) {
    // Slack can stop the stream before delivering the native Stop event. Its
    // session lifecycle still needs an explicit transition out of processing.
    if (
      !(error instanceof SlackApiError) ||
      !["message_not_in_streaming_state", "stopped_by_user"].includes(error.code)
    )
      throw error
    await slack("agents.sessions.setStatus", {
      channel_id: checkpoint.channel,
      thread_ts: checkpoint.threadTs,
      status: checkpoint.finalStatus,
    })
  }
}
async function appendText(
  slack: SlackCall,
  checkpoint: Checkpoint,
  text: string,
  onPart?: (part: string) => Promise<void>,
) {
  for (let offset = 0; offset < text.length; offset += 10_000) {
    const part = text.slice(offset, offset + 10_000)
    if (checkpoint.streamCharacters + part.length > 30_000) {
      await stopSlackStream(slack, checkpoint, { session_status: "processing" })
      const stream = z.object({ ts: z.string() }).parse(
        await slack("chat.startStream", {
          channel: checkpoint.channel,
          thread_ts: checkpoint.threadTs,
          recipient_user_id: checkpoint.recipientUserId,
          recipient_team_id: checkpoint.recipientTeamId,
          chunks: [{ type: "markdown_text", text: "OpenWork task · continued\n\n" }],
          task_display_mode: "timeline",
        }),
      )
      checkpoint.streamTs = stream.ts
      checkpoint.streamCharacters = 0
    }
    await slack("chat.appendStream", {
      channel: checkpoint.channel,
      ts: checkpoint.streamTs,
      chunks: [{ type: "markdown_text", text: part }],
    })
    checkpoint.streamCharacters += part.length
    await onPart?.(part)
  }
}
export async function advanceSlackRun(input: {
  checkpoint: Checkpoint
  remote: RemoteCall
  slack: SlackCall
  messageId: string
  saveSession: (sessionId: string, workspaceId: string) => Promise<void>
  title: string
  needsAttention?: (sessionId: string) => Promise<boolean>
  persist?: (checkpoint: Checkpoint) => Promise<void>
}): Promise<{ checkpoint: Checkpoint; delayMs: number; done?: boolean }> {
  const cp = input.checkpoint
  if (cp.phase === "create") {
    if (!cp.sessionId) {
      // Persist the empty native session before submitting any user instruction.
      const result = await input.remote("create", { title: input.title, target: "cloud" })
      if (result.error) return retryProvisioning(result, cp, input.slack)
      const created = z.object({ sessionId: z.string(), workspaceId: z.string() }).parse(result)
      await input.saveSession(created.sessionId, created.workspaceId)
      cp.sessionId = created.sessionId
      cp.workspaceId = created.workspaceId
    }
    cp.phase = "send"
    return { checkpoint: cp, delayMs: 0 }
  }
  if (cp.phase === "send") {
    const result = await input.remote("send", {
      sessionId: cp.sessionId,
      prompt: cp.prompt,
      messageId: input.messageId,
    })
    if (result.error) return retryProvisioning(result, cp, input.slack)
    cp.phase = "read"
    cp.prompt = undefined
    return { checkpoint: cp, delayMs: 1_000 }
  }
  if (cp.phase === "read") {
    if (cp.sessionId && (await input.needsAttention?.(cp.sessionId))) {
      await appendText(
        input.slack,
        cp,
        `\n\nI need your input or approval. [Open in OpenWork Web](${webLink(cp.sessionId)}).`,
      )
      cp.finalStatus = "suspended"
      cp.phase = "finish"
      return { checkpoint: cp, delayMs: 0 }
    }
    const result = await input.remote("read", { sessionId: cp.sessionId, messageId: input.messageId, limit: 100 })
    if (result.error) return retryProvisioning(result, cp, input.slack)
    const snapshot = readSchema.parse(result)
    if (!cp.titleSynced && snapshot.title) {
      await input.slack("agents.sessions.rename", {
        channel_id: cp.channel,
        thread_ts: cp.threadTs,
        title: snapshot.title.slice(0, 200),
      })
      cp.titleSynced = true
      await input.persist?.(cp)
    }
    const delta = currentReplyDelta(cp.sentText, snapshot.finalAssistantText)
    if (delta)
      await appendText(input.slack, cp, delta, async (part) => {
        cp.sentText += part
        cp.firstTextAt ??= Date.now()
        await input.persist?.(cp)
      })
    const updates = new Map<
      string,
      {
        type: "task_update"
        id: string
        title: string
        status: "complete" | "error" | "in_progress"
        rawStatus: string
      }
    >()
    for (const message of snapshot.messages)
      for (const tool of message.toolCalls) {
        if (cp.steps[tool.id] === (tool.status ?? "pending")) continue
        const status = tool.status === "completed" ? "complete" : tool.status === "error" ? "error" : "in_progress"
        updates.set(tool.id, {
          type: "task_update",
          id: scopeKey(tool.id),
          title: "Working with your connections",
          status,
          rawStatus: tool.status ?? "pending",
        })
      }
    const entries = [...updates.entries()]
    for (let offset = 0; offset < entries.length; offset += 20) {
      const batch = entries.slice(offset, offset + 20)
      await input.slack("chat.appendStream", {
        channel: cp.channel,
        ts: cp.streamTs,
        chunks: batch.map(([, { rawStatus, ...chunk }]) => chunk),
      })
      for (const [id, update] of batch) cp.steps[id] = update.rawStatus
      await input.persist?.(cp)
    }
    if (snapshot.terminalError) {
      await appendText(
        input.slack,
        cp,
        `\n\nThis task needs attention. [Open in OpenWork Web](${webLink(cp.sessionId ?? "")}).`,
      )
      cp.finalStatus = "suspended"
      cp.phase = "finish"
    } else if (snapshot.status === "idle" && Boolean(snapshot.finalAssistantText)) cp.phase = "finish"
    return { checkpoint: cp, delayMs: 1_000 }
  }
  cp.completedAt ??= Date.now()
  await stopSlackStream(input.slack, cp, {
    chunks: [{ type: "markdown_text", text: `\n\n[Open in OpenWork Web](${webLink(cp.sessionId ?? "")})` }],
    blocks: [
      {
        type: "context_actions",
        elements: [
          {
            type: "feedback_buttons",
            action_id: `slack_feedback:${input.messageId.replace(/^msg_/, "")}`,
            positive_button: { text: { type: "plain_text", text: "Helpful" }, value: "positive" },
            negative_button: { text: { type: "plain_text", text: "Needs work" }, value: "negative" },
          },
        ],
      },
    ],
  })
  return { checkpoint: cp, delayMs: 0, done: true }
}
export class RemoteSessionUnavailableError extends Error {
  constructor() {
    super("remote_session_unavailable")
  }
}
function retryProvisioning(result: Record<string, unknown>, cp: Checkpoint, slack: SlackCall) {
  return (async () => {
    if (result.retryable !== true) throw new RemoteSessionUnavailableError()
    if (!cp.wakeShown && String(result.error).startsWith("cloud_runtime_")) {
      await appendText(slack, cp, "Waking your workspace…\n\n")
      cp.wakeShown = true
    }
    return {
      checkpoint: cp,
      delayMs: typeof result.retryAfterMs === "number" ? Math.max(1_000, Math.min(60_000, result.retryAfterMs)) : 5_000,
    }
  })()
}
