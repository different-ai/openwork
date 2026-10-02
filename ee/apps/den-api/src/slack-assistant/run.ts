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
  streamStartedAt: z.number().optional(),
  recipientUserId: z.string().optional(),
  recipientTeamId: z.string().optional(),
  wakeShown: z.boolean().default(false),
  finalStatus: z.enum(["active", "suspended"]).default("active"),
  titleSynced: z.boolean().default(false),
  startedAt: z.number().optional(),
  stillWorkingShown: z.boolean().default(false),
  /** A long task stopped streaming progress; it posts hourly check-ins and its final answer instead. */
  quiet: z.boolean().default(false),
  lastCheckInAt: z.number().optional(),
  /** A message sent while an earlier task ran was acknowledged once. */
  queuedNoticeShown: z.boolean().default(false),
  /** Streams live progress. A busy workspace starts new tasks without it: Slack's working status, then the answer. */
  live: z.boolean().default(true),
  /** Waited for one of this person's running tasks to finish; they were told once. */
  slotNoticeShown: z.boolean().default(false),
  /** Waited for a free runner slot; the person was told once. */
  waitingShown: z.boolean().default(false),
})
type Checkpoint = z.infer<typeof checkpointSchema>
const readSchema = z.object({
  status: z.string(),
  title: z.string().nullable().optional(),
  messageCount: z.number(),
  finalAssistantText: z.string(),
  /** The last assistant message alone; runtimes without it fall back to finalAssistantText. */
  lastAssistantText: z.string().optional(),
  /** The runtime accepted the turn but has not started it: every slot is busy. */
  waiting: z.boolean().optional(),
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

/** Runs longer than this get a separate "done" reply, because updating a streamed message does not notify anyone. */
export const DONE_PING_AFTER_MS = 60_000
/** With no answer text by then, say the work continues and the reply will land in this thread. */
export const STILL_WORKING_AFTER_MS = 20_000
export const STILL_WORKING_LINE = "Still working on it. I'll reply here when it's done.\n\n"

/**
 * A long task streams live progress for its first few minutes, then goes quiet: one line saying so, an hourly
 * check-in, and its final answer as a new reply that mentions the person. This is before Slack's stream
 * lifetime, so the live reply never has to continue in another message.
 */
export const LONG_TASK_QUIET_AFTER_MS = 4 * 60_000
export const LONG_TASK_LINE =
  "This one will take a while. I'll keep working and post the result here when I'm done. Press Stop to cancel."
export const CHECK_IN_EVERY_MS = 60 * 60_000
/** A quiet task is read less often; nothing is shown until the next check-in or the answer. */
const QUIET_POLL_MS = 5_000
/** The reply to a message sent while an earlier task is still running in the thread. */
export const QUEUED_LINE = "Got it. I'll do this right after the current task. Press Stop to end that task and start this now."
/** The reply to a request over the intake limit. */
export const THROTTLED_LINE = "I'm getting a lot of requests right now, so I didn't start this one. Please send it again in a minute."
/** Said once when the runtime has had no free slot for a while. */
export const WAITING_LINE = "Lots of requests right now, so this one is waiting for a free spot. It will start on its own."
const WAITING_NOTICE_AFTER_MS = 15_000
/** Live tasks are read every second at first, then every 3 seconds: fewer Slack and database calls per task. */
const LIVE_POLL_FAST_MS = 1_000
const LIVE_POLL_MS = 3_000
const LIVE_POLL_FAST_FOR_MS = 30_000

export function formatElapsed(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** What the thread is told when a task ends without an answer. */
function failureText(webHandoff: boolean, sessionId: string | undefined, terminalError: unknown) {
  return webHandoff
    ? `This task needs attention. [Open in OpenWork Web](${webLink(sessionId ?? "")}).`
    : headlessFailureText(terminalError)
}

/** What the thread is told when a headless task ends without an answer. */
function headlessFailureText(terminalError: unknown) {
  const code = z.object({ code: z.string() }).catch({ code: "" }).parse(terminalError).code
  return code === "stuck_repeating"
    ? "I got stuck repeating the same step, so I stopped. Try again, or ask in a different way."
    : "This task couldn't finish. Try again, or ask in a different way."
}

/** First meaningful line of the answer, for the "done" reply. */
export function doneSummary(text: string) {
  const line = text
    .split("\n")
    .map((entry) => entry.replace(/\*\*|__/g, "").replace(/^[#>*\-\s]+/, "").trim())
    .find((entry) => entry.length > 0)
  if (!line) return "your answer is above."
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

export function currentReplyDelta(previous: string, current: string) {
  // A revised answer must not append an unrelated full transcript.
  return current.startsWith(previous) ? current.slice(previous.length) : ""
}
/**
 * Slack closes a streamed message on its own after about five minutes, even while it is still being appended
 * to (`message_not_in_streaming_state`). Long runs continue in a fresh message in the same thread before that.
 */
export const STREAM_ROTATE_AFTER_MS = 4 * 60_000
/** Characters one streamed message carries before the reply continues in a new one. */
export const STREAM_CHARACTER_LIMIT = 30_000
export const STREAM_CONTINUED_LINE = "OpenWork task · continued\n\n"

type Chunk = Record<string, unknown>
const continued = (): Chunk => ({ type: "markdown_text", text: STREAM_CONTINUED_LINE })

function chunkText(chunks: unknown) {
  return z
    .array(z.object({ text: z.string().optional() }).loose())
    .catch([])
    .parse(chunks)
    .map((chunk) => chunk.text ?? "")
    .join("")
}

function streamClosedBySlack(error: unknown) {
  return error instanceof SlackApiError && error.code === "message_not_in_streaming_state"
}

async function startStream(slack: SlackCall, checkpoint: Checkpoint, chunks: Chunk[], now: () => number) {
  const stream = z.object({ ts: z.string() }).parse(
    await slack("chat.startStream", {
      channel: checkpoint.channel,
      thread_ts: checkpoint.threadTs,
      recipient_user_id: checkpoint.recipientUserId,
      recipient_team_id: checkpoint.recipientTeamId,
      chunks,
      task_display_mode: "timeline",
    }),
  )
  checkpoint.streamTs = stream.ts
  checkpoint.streamStartedAt = now()
  checkpoint.streamCharacters = chunkText(chunks).length
}

/**
 * Sends chunks to the reply. The stream opens with its first real content (a task step or answer text), so a
 * quick answer never starts with a placeholder; Slack's thinking status covers the gap until then. A long reply
 * continues in a new message before Slack's lifetime or size limit, or right after Slack closed it anyway; the
 * Slack session stays in progress throughout, so the native Stop button keeps working.
 */
async function sendChunks(slack: SlackCall, checkpoint: Checkpoint, chunks: Chunk[], now: () => number) {
  if (!checkpoint.streamTs) return startStream(slack, checkpoint, chunks, now)
  const size = chunkText(chunks).length
  // Checkpoints written before streams were timed start their clock now; Slack closing them early is still handled below.
  checkpoint.streamStartedAt ??= now()
  if (now() - checkpoint.streamStartedAt >= STREAM_ROTATE_AFTER_MS || checkpoint.streamCharacters + size > STREAM_CHARACTER_LIMIT) {
    try {
      await slack("chat.stopStream", { channel: checkpoint.channel, ts: checkpoint.streamTs, session_status: "processing" })
    } catch (error) {
      if (!streamClosedBySlack(error)) throw error
    }
    return startStream(slack, checkpoint, [continued(), ...chunks], now)
  }
  try {
    await slack("chat.appendStream", { channel: checkpoint.channel, ts: checkpoint.streamTs, chunks })
    checkpoint.streamCharacters += size
  } catch (error) {
    if (!streamClosedBySlack(error)) throw error
    await startStream(slack, checkpoint, [continued(), ...chunks], now)
  }
}

export async function stopSlackStream(slack: SlackCall, checkpoint: Checkpoint, extra: Record<string, unknown> = {}) {
  await closeStream(slack, checkpoint, checkpoint.finalStatus, extra)
}

/** Ends the reply message and leaves the Slack session in `status` ("processing" keeps Stop available). */
async function closeStream(
  slack: SlackCall,
  checkpoint: Checkpoint,
  status: "active" | "suspended" | "processing",
  extra: Record<string, unknown> = {},
) {
  // Closing text (a final link, "Stopped.") goes out as a plain reply when there is no open stream to carry it.
  const postClosingText = async () => {
    const text = chunkText(extra.chunks).trim()
    if (text && checkpoint.channel) await slack("chat.postMessage", { channel: checkpoint.channel, thread_ts: checkpoint.threadTs, text })
  }
  const setFinalStatus = () =>
    slack("agents.sessions.setStatus", {
      channel_id: checkpoint.channel,
      thread_ts: checkpoint.threadTs,
      status,
    })
  if (!checkpoint.streamTs) {
    // Nothing was streamed yet: deliver any closing text as a plain reply and clear the thinking status.
    await postClosingText()
    await setFinalStatus()
    return
  }
  try {
    await slack("chat.stopStream", {
      channel: checkpoint.channel,
      ts: checkpoint.streamTs,
      session_status: status,
      ...extra,
    })
  } catch (error) {
    // Slack can stop the stream before delivering the native Stop event, or close it on its own. The session
    // lifecycle still needs an explicit transition out of processing, and closing text must not be lost.
    if (
      !(error instanceof SlackApiError) ||
      !["message_not_in_streaming_state", "stopped_by_user"].includes(error.code)
    )
      throw error
    if (streamClosedBySlack(error)) await postClosingText()
    await setFinalStatus()
  }
}
async function appendText(
  slack: SlackCall,
  checkpoint: Checkpoint,
  text: string,
  now: () => number,
  onPart?: (part: string) => Promise<void>,
) {
  for (let offset = 0; offset < text.length; offset += 10_000) {
    const part = text.slice(offset, offset + 10_000)
    await sendChunks(slack, checkpoint, [{ type: "markdown_text", text: part }], now)
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
  /** False for the headless runner: there is no OpenWork Web session to hand off to. */
  webHandoff?: boolean
  /** Gateway model alias for the headless runner, chosen by the workspace admin. */
  model?: string
  /** Long tasks stop streaming progress after this long (the headless runtime); unset streams the whole run. */
  quietAfterMs?: number
  now?: () => number
}): Promise<{ checkpoint: Checkpoint; delayMs: number; done?: boolean }> {
  const cp = input.checkpoint
  const webHandoff = input.webHandoff !== false
  const now = input.now ?? Date.now
  if (cp.phase === "create") {
    if (!cp.sessionId) {
      // Persist the empty native session before submitting any user instruction.
      const result = await input.remote("create", { title: input.title, target: "cloud" })
      if (result.error) return retryProvisioning(result, cp, input.slack, now)
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
      ...(input.model ? { model: input.model } : {}),
    })
    if (result.error === "unknown_session") {
      // The runtime no longer has this conversation (old sessions expire): start a fresh one with the same prompt,
      // which carries the thread's recent messages.
      cp.sessionId = undefined
      cp.workspaceId = undefined
      cp.phase = "create"
      return { checkpoint: cp, delayMs: 0 }
    }
    if (result.error) return retryProvisioning(result, cp, input.slack, now)
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
        now,
      )
      cp.finalStatus = "suspended"
      cp.phase = "finish"
      return { checkpoint: cp, delayMs: 0 }
    }
    const result = await input.remote("read", { sessionId: cp.sessionId, messageId: input.messageId, limit: 100 })
    if (result.error) return retryProvisioning(result, cp, input.slack, now)
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
    const finished = snapshot.status === "idle" && Boolean(snapshot.finalAssistantText)
    if (snapshot.waiting && !cp.waitingShown && cp.startedAt !== undefined && now() - cp.startedAt >= WAITING_NOTICE_AFTER_MS) {
      await input.slack("chat.postMessage", { channel: cp.channel, thread_ts: cp.threadTs, text: WAITING_LINE })
      cp.waitingShown = true
      await input.persist?.(cp)
    }
    if (cp.quiet) {
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, headlessFailureText(snapshot.terminalError), now)
        cp.finalStatus = "suspended"
        cp.phase = "finish"
      } else if (finished) {
        // Only the final answer: the person did not see the progress notes before it.
        await appendText(input.slack, cp, snapshot.lastAssistantText || snapshot.finalAssistantText, now, async (part) => {
          cp.sentText += part
          await input.persist?.(cp)
        })
        cp.phase = "finish"
      } else if (now() - (cp.lastCheckInAt ?? now()) >= CHECK_IN_EVERY_MS) {
        await input.slack("chat.postMessage", {
          channel: cp.channel,
          thread_ts: cp.threadTs,
          text: `Still working on it (${formatElapsed(now() - (cp.startedAt ?? now()))} so far).`,
        })
        cp.lastCheckInAt = now()
        await input.persist?.(cp)
      }
      return { checkpoint: cp, delayMs: cp.phase === "finish" ? 0 : QUIET_POLL_MS }
    }
    if (
      !snapshot.terminalError &&
      !finished &&
      input.quietAfterMs !== undefined &&
      cp.startedAt !== undefined &&
      now() - cp.startedAt >= input.quietAfterMs
    ) {
      // Before sending anything else, so the live reply never needs a second message. The Slack session stays in
      // progress so Stop stays available; the answer comes later as a new reply.
      await closeStream(input.slack, cp, "processing", { chunks: [{ type: "markdown_text", text: `\n\n${LONG_TASK_LINE}` }] })
      cp.streamTs = undefined
      cp.streamStartedAt = undefined
      cp.streamCharacters = 0
      cp.sentText = ""
      cp.quiet = true
      cp.lastCheckInAt = now()
      await input.persist?.(cp)
      return { checkpoint: cp, delayMs: QUIET_POLL_MS }
    }
    if (!cp.live) {
      // No live progress: Slack's working status shows until the answer (or the long-task note) arrives.
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, failureText(webHandoff, cp.sessionId, snapshot.terminalError), now)
        cp.finalStatus = "suspended"
        cp.phase = "finish"
      } else if (finished) {
        await appendText(input.slack, cp, snapshot.lastAssistantText || snapshot.finalAssistantText, now, async (part) => {
          cp.sentText += part
          cp.firstTextAt ??= now()
          await input.persist?.(cp)
        })
        cp.phase = "finish"
      }
      return { checkpoint: cp, delayMs: cp.phase === "finish" ? 0 : LIVE_POLL_MS }
    }
    const delta = currentReplyDelta(cp.sentText, snapshot.finalAssistantText)
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
          // The headless runtime reports readable step labels; OpenCode tool ids stay generic.
          title: tool.name.includes(" ") ? tool.name : "Working with your connections",
          status,
          rawStatus: tool.status ?? "pending",
        })
      }
    const entries = [...updates.entries()]
    if (delta && delta.length <= 10_000 && entries.length <= 20) {
      // New text and step changes travel in one Slack call.
      await sendChunks(input.slack, cp, [{ type: "markdown_text", text: delta }, ...entries.map(([, { rawStatus, ...chunk }]) => chunk)], now)
      cp.sentText += delta
      cp.firstTextAt ??= now()
      for (const [id, update] of entries) cp.steps[id] = update.rawStatus
      await input.persist?.(cp)
    } else {
      if (delta)
        await appendText(input.slack, cp, delta, now, async (part) => {
          cp.sentText += part
          cp.firstTextAt ??= now()
          await input.persist?.(cp)
        })
      for (let offset = 0; offset < entries.length; offset += 20) {
        const batch = entries.slice(offset, offset + 20)
        const chunks = batch.map(([, { rawStatus, ...chunk }]) => chunk)
        await sendChunks(input.slack, cp, chunks, now)
        for (const [id, update] of batch) cp.steps[id] = update.rawStatus
        await input.persist?.(cp)
      }
    }
    const noAnswerYet = !cp.sentText && !snapshot.finalAssistantText
    if (noAnswerYet && !cp.stillWorkingShown && cp.startedAt !== undefined && now() - cp.startedAt > STILL_WORKING_AFTER_MS) {
      await appendText(input.slack, cp, STILL_WORKING_LINE, now)
      cp.stillWorkingShown = true
      await input.persist?.(cp)
    }
    if (snapshot.terminalError) {
      await appendText(
        input.slack,
        cp,
        `\n\n${failureText(webHandoff, cp.sessionId, snapshot.terminalError)}`,
        now,
      )
      cp.finalStatus = "suspended"
      cp.phase = "finish"
    } else if (finished) cp.phase = "finish"
    const fast = cp.startedAt === undefined || now() - cp.startedAt < LIVE_POLL_FAST_FOR_MS
    return { checkpoint: cp, delayMs: fast ? LIVE_POLL_FAST_MS : LIVE_POLL_MS }
  }
  cp.completedAt ??= now()
  await stopSlackStream(input.slack, cp, {
    ...(webHandoff
      ? { chunks: [{ type: "markdown_text", text: `\n\n[Open in OpenWork Web](${webLink(cp.sessionId ?? "")})` }] }
      : {}),
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
  if (cp.startedAt !== undefined && cp.completedAt - cp.startedAt > DONE_PING_AFTER_MS && cp.recipientUserId) {
    try {
      await input.slack("chat.postMessage", {
        channel: cp.channel,
        thread_ts: cp.threadTs,
        text:
          cp.finalStatus === "suspended"
            ? `<@${cp.recipientUserId}> This task needs your attention. Details are above.`
            : `<@${cp.recipientUserId}> Done: ${doneSummary(cp.sentText)}`,
      })
    } catch {
      // The answer is already delivered; a missed ping must not fail the run.
    }
  }
  return { checkpoint: cp, delayMs: 0, done: true }
}
export class RemoteSessionUnavailableError extends Error {
  constructor() {
    super("remote_session_unavailable")
  }
}
function retryProvisioning(result: Record<string, unknown>, cp: Checkpoint, slack: SlackCall, now: () => number) {
  return (async () => {
    if (result.retryable !== true) throw new RemoteSessionUnavailableError()
    if (!cp.wakeShown && String(result.error).startsWith("cloud_runtime_")) {
      await appendText(slack, cp, "Waking your workspace…\n\n", now)
      cp.wakeShown = true
    }
    return {
      checkpoint: cp,
      delayMs: typeof result.retryAfterMs === "number" ? Math.max(1_000, Math.min(60_000, result.retryAfterMs)) : 5_000,
    }
  })()
}
