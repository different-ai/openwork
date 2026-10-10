import { z } from "zod"
import type { RunnerFailure, SlackRunner, SlackRunStep } from "./headless.js"
import { scopeKey, SlackApiError, type SlackCall } from "./protocol.js"
export const checkpointSchema = z.object({
  phase: z.enum(["create", "send", "read", "finish"]).default("create"),
  channel: z.string().optional(),
  threadTs: z.string().optional(),
  streamTs: z.string().optional(),
  sessionId: z.string().optional(),
  /** Kept until the run ends, so a run whose runner session vanished can start again in a fresh one. */
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
  finalStatus: z.enum(["active", "suspended"]).default("active"),
  startedAt: z.number().optional(),
  stillWorkingShown: z.boolean().default(false),
  /** A long task stopped streaming progress; it posts hourly check-ins and its final answer instead. */
  quiet: z.boolean().default(false),
  lastCheckInAt: z.number().optional(),
  /** A message sent while an earlier task ran was acknowledged once. */
  queuedNoticeShown: z.boolean().default(false),
  /** Streams live progress. Off: Slack's working status shows until the answer. Set per task when it starts. */
  live: z.boolean().default(true),
  /** Times the thread's runner session was found missing and replaced; once at most per message. */
  sessionResets: z.number().default(0),
})
export type Checkpoint = z.infer<typeof checkpointSchema>

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
/** A task without live progress is read every 3 seconds: nothing is shown until its answer. */
const NOT_LIVE_POLL_MS = 3_000
/** The reply to a message sent while an earlier task is still running in the thread. */
export const QUEUED_LINE = "Got it. I'll do this right after the current task. Press Stop to end that task and start this now."

export function formatElapsed(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/** What the thread is told when a task ends without an answer. */
function failureText(terminalError: { code: string }) {
  return terminalError.code === "stuck_repeating"
    ? "I got stuck repeating the same step, so I stopped. Try again, or ask in a different way."
    : "This task couldn't finish. Try again, or ask in a different way."
}

/** A line that only titles what follows: a markdown heading, a bold-only line, or a short "Label:" line. */
function isHeadingLine(raw: string, cleaned: string) {
  if (/^\s*#{1,6}\s/.test(raw)) return true
  if (/^[>*\-\s]*(\*\*|__)[^*_]+(\*\*|__)\W*$/.test(raw)) return true
  return cleaned.endsWith(":") && cleaned.length <= 60
}

/** First sentence of the first real paragraph of the answer, for the "done" reply. */
export function doneSummary(text: string) {
  const line = text
    .split("\n")
    .map((raw) => ({ raw, cleaned: raw.replace(/\*\*|__/g, "").replace(/^[#>*\-\s]+/, "").trim() }))
    .find((entry) => entry.cleaned.length > 0 && !isHeadingLine(entry.raw, entry.cleaned))?.cleaned
  if (!line) return "your answer is above."
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line)?.[0] ?? line
  return sentence.length > 140 ? `${sentence.slice(0, 139)}…` : sentence
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
  runner: SlackRunner
  slack: SlackCall
  messageId: string
  saveSession: (sessionId: string) => Promise<void>
  /** Forgets the thread's runner session, so the next message in the thread starts a fresh one. */
  clearSession: () => Promise<void>
  title: string
  persist?: (checkpoint: Checkpoint) => Promise<void>
  /** Gateway model alias for the runner, chosen by the workspace admin. */
  model?: string
  /** Long tasks stop streaming progress after this long. */
  quietAfterMs?: number
  now?: () => number
}): Promise<{ checkpoint: Checkpoint; delayMs: number; done?: boolean }> {
  const cp = input.checkpoint
  const now = input.now ?? Date.now
  const quietAfterMs = input.quietAfterMs ?? LONG_TASK_QUIET_AFTER_MS
  if (cp.phase === "create") {
    if (!cp.sessionId) {
      // Persist the empty session before submitting any user instruction.
      const created = await input.runner.create({ title: input.title })
      if (!created.ok) return retryLater(created, cp)
      await input.saveSession(created.sessionId)
      cp.sessionId = created.sessionId
    }
    cp.phase = "send"
    return { checkpoint: cp, delayMs: 0 }
  }
  if (cp.phase === "send") {
    const sent = await input.runner.send({
      sessionId: cp.sessionId ?? "",
      prompt: cp.prompt ?? "",
      messageId: input.messageId,
      ...(input.model ? { model: input.model } : {}),
    })
    if (!sent.ok) return sent.error === "unknown_session" ? startInFreshSession(input, cp) : retryLater(sent, cp)
    cp.phase = "read"
    return { checkpoint: cp, delayMs: 1_000 }
  }
  if (cp.phase === "read") {
    const read = await input.runner.read({ sessionId: cp.sessionId ?? "", messageId: input.messageId })
    if (!read.ok) return read.error === "unknown_session" ? startInFreshSession(input, cp) : retryLater(read, cp)
    const snapshot = read.snapshot
    const finished = snapshot.status === "idle" && Boolean(snapshot.finalAssistantText)
    if (!cp.live) {
      // Quiet: Slack's working status (with its Stop button) shows until the answer, which arrives on its own.
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, failureText(snapshot.terminalError), now)
        cp.finalStatus = "suspended"
        cp.phase = "finish"
      } else if (finished) {
        // Only the answer, not the notes the agent wrote on the way.
        await appendText(input.slack, cp, snapshot.lastAssistantText || snapshot.finalAssistantText, now, async (part) => {
          cp.sentText += part
          cp.firstTextAt ??= now()
          await input.persist?.(cp)
        })
        cp.phase = "finish"
      }
      return { checkpoint: cp, delayMs: cp.phase === "finish" ? 0 : NOT_LIVE_POLL_MS }
    }
    if (cp.quiet) {
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, failureText(snapshot.terminalError), now)
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
    if (!snapshot.terminalError && !finished && cp.startedAt !== undefined && now() - cp.startedAt >= quietAfterMs) {
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
    const delta = currentReplyDelta(cp.sentText, snapshot.finalAssistantText)
    if (delta)
      await appendText(input.slack, cp, delta, now, async (part) => {
        cp.sentText += part
        cp.firstTextAt ??= now()
        await input.persist?.(cp)
      })
    await sendStepUpdates(input.slack, cp, snapshot.steps, now, input.persist)
    const noAnswerYet = !cp.sentText && !snapshot.finalAssistantText
    if (noAnswerYet && !cp.stillWorkingShown && cp.startedAt !== undefined && now() - cp.startedAt > STILL_WORKING_AFTER_MS) {
      await appendText(input.slack, cp, STILL_WORKING_LINE, now)
      cp.stillWorkingShown = true
      await input.persist?.(cp)
    }
    if (snapshot.terminalError) {
      await appendText(input.slack, cp, `\n\n${failureText(snapshot.terminalError)}`, now)
      cp.finalStatus = "suspended"
      cp.phase = "finish"
    } else if (finished) cp.phase = "finish"
    return { checkpoint: cp, delayMs: 1_000 }
  }
  cp.completedAt ??= now()
  // The run is over; the prompt is only needed to start it again.
  cp.prompt = undefined
  await stopSlackStream(input.slack, cp, {
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
  // A quiet task's answer is a new reply, which already notifies; only a streamed reply needs the extra mention.
  if (cp.live && cp.startedAt !== undefined && cp.completedAt - cp.startedAt > DONE_PING_AFTER_MS && cp.recipientUserId) {
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

/** Task steps not yet shown (or whose status changed) go to Slack's task timeline, 20 per chunk batch. */
async function sendStepUpdates(
  slack: SlackCall,
  cp: Checkpoint,
  steps: SlackRunStep[],
  now: () => number,
  persist?: (checkpoint: Checkpoint) => Promise<void>,
) {
  const updates = new Map<string, { chunk: Chunk; rawStatus: string }>()
  for (const step of steps) {
    if (cp.steps[step.id] === step.status) continue
    updates.set(step.id, {
      chunk: {
        type: "task_update",
        id: scopeKey(step.id),
        title: step.label.includes(" ") ? step.label : "Working with your connections",
        status: step.status === "completed" ? "complete" : step.status === "error" ? "error" : "in_progress",
      },
      rawStatus: step.status,
    })
  }
  const entries = [...updates.entries()]
  for (let offset = 0; offset < entries.length; offset += 20) {
    const batch = entries.slice(offset, offset + 20)
    await sendChunks(slack, cp, batch.map(([, update]) => update.chunk), now)
    for (const [id, update] of batch) cp.steps[id] = update.rawStatus
    await persist?.(cp)
  }
}

export class RemoteSessionUnavailableError extends Error {
  constructor() {
    super("remote_session_unavailable")
  }
}

/** Retries a runner call that may work later; anything else ends the run. */
function retryLater(result: RunnerFailure, cp: Checkpoint) {
  if (!result.retryable) throw new RemoteSessionUnavailableError()
  return {
    checkpoint: cp,
    delayMs: typeof result.retryAfterMs === "number" ? Math.max(1_000, Math.min(60_000, result.retryAfterMs)) : 5_000,
  }
}

/**
 * The thread's saved runner session no longer exists (the runner lost it, or the thread was started on an earlier
 * runtime). Forget it and run this same message again in a fresh session, once; the answer starts over.
 */
async function startInFreshSession(input: { clearSession: () => Promise<void>; persist?: (checkpoint: Checkpoint) => Promise<void> }, cp: Checkpoint) {
  if (cp.sessionResets >= 1 || !cp.prompt) throw new RemoteSessionUnavailableError()
  cp.sessionResets += 1
  await input.clearSession()
  cp.sessionId = undefined
  cp.phase = "create"
  cp.sentText = ""
  cp.steps = {}
  await input.persist?.(cp)
  return { checkpoint: cp, delayMs: 0 }
}
