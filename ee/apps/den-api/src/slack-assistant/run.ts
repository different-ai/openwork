import { z } from "zod"
import { excerpt, slackSafeText } from "./desktop-handoff-messages.js"
import type { RunnerFailure, SlackRunner, SlackRunSnapshot, SlackRunStep, SlackSessionSettings } from "./headless.js"
import type { LiveFeed, LiveFeedSource } from "./live.js"
import { scopeKey, slackReactionName, SlackApiError, type SlackCall } from "./protocol.js"
export const checkpointSchema = z.object({
  /** watch: the answer is done; the message's background tasks are still running and report back in the thread. */
  phase: z.enum(["create", "send", "read", "finish", "watch"]).default("create"),
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
  /** Answered like Workbot (`slackWorkbotReplies`, set per message when it starts): text streams as it is written. */
  workbot: z.boolean().default(false),
  /** The person's message, to react to; unset when a reaction would show in a channel the reply avoids. */
  reactTo: z.object({ channel: z.string(), ts: z.string() }).optional(),
  reacted: z.boolean().default(false),
  /**
   * Live text: the runner step being written (unset: not known yet), what of it has arrived, and whether its start was
   * missed (then only its stored text is used). `liveWindow` counts streaming windows, so a feed only continues into
   * the window right after its own.
   */
  liveWindow: z.number().default(0),
  liveStep: z.number().optional(),
  liveText: z.string().default(""),
  liveBlind: z.boolean().default(false),
  /** Background tasks this message started, the reports already posted, and when watching for them stops. */
  taskIds: z.array(z.string()).default([]),
  reported: z.array(z.string()).default([]),
  watchUntil: z.number().optional(),
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
/** How long one call streams a reply before handing the event back to the queue (its lease is renewed meanwhile). */
export const LIVE_WINDOW_MS = 20_000
/** Live text is appended to Slack at most this often; deltas in between are batched. */
export const LIVE_FLUSH_MS = 1_000
/** Without a reason to read the session sooner, it is read this often while streaming, in case an event was missed. */
const LIVE_SAFETY_READ_MS = 3_000
/** A message's background tasks are checked this often, and watched for at most a day. */
export const WATCH_POLL_MS = 10_000
export const WATCH_MAX_MS = 24 * 60 * 60_000

type RunInput = {
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
  /** The session's settings, brought up to date before the message is sent. */
  settings?: SlackSessionSettings
  /** The runner's live events, for answers like Workbot. Without it the reply follows the stored messages. */
  live?: LiveFeedSource
  /** Keeps the event's lease while a window streams. */
  renew?: () => Promise<void>
  /** Reports a problem that doesn't stop the run (a reaction Slack refused). */
  log?: (message: string, fields: Record<string, string>) => void
  liveWindowMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

type Step = { checkpoint: Checkpoint; delayMs: number; done?: boolean; watch?: boolean }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function advanceSlackRun(input: RunInput): Promise<Step> {
  const cp = input.checkpoint
  const now = input.now ?? Date.now
  if (cp.phase === "create") {
    if (!cp.sessionId) {
      // Persist the empty session before submitting any user instruction.
      const created = await input.runner.create({ title: input.title, ...(cp.workbot ? { settings: input.settings } : {}) })
      if (!created.ok) return retryLater(created, cp)
      await input.saveSession(created.sessionId)
      cp.sessionId = created.sessionId
    }
    cp.phase = "send"
    return { checkpoint: cp, delayMs: 0 }
  }
  if (cp.phase === "send") {
    const sessionId = cp.sessionId ?? ""
    // Listen before sending, so the first words of the answer are seen as they are written.
    const feed = cp.workbot && input.live ? await input.live.acquire(sessionId, cp.liveWindow) : null
    const sent = await input.runner.send({
      sessionId,
      prompt: cp.prompt ?? "",
      messageId: input.messageId,
      ...(input.model ? { model: input.model } : {}),
      ...(input.settings ? { settings: input.settings } : {}),
    })
    if (!sent.ok) {
      feed?.release(cp.liveWindow)
      return sent.error === "unknown_session" ? startInFreshSession(input, cp) : retryLater(sent, cp)
    }
    cp.phase = "read"
    if (!cp.workbot) return { checkpoint: cp, delayMs: 1_000 }
    // A new turn has written nothing yet; a turn the runner already had may be part-way through a step.
    cp.liveStep = sent.accepted && feed ? 0 : undefined
    cp.liveText = ""
    cp.liveBlind = false
    await input.persist?.(cp)
    return liveWindow(input, cp, feed)
  }
  if (cp.phase === "read") {
    if (!cp.live && !cp.workbot) {
      const read = await input.runner.read({ sessionId: cp.sessionId ?? "", messageId: input.messageId })
      if (!read.ok) return read.error === "unknown_session" ? startInFreshSession(input, cp) : retryLater(read, cp)
      const snapshot = read.snapshot
      // Quiet: Slack's working status (with its Stop button) shows until the answer, which arrives on its own.
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, failureText(snapshot.terminalError), now)
        cp.finalStatus = "suspended"
        cp.phase = "finish"
      } else if (finishedTurn(cp, snapshot)) {
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
      const read = await input.runner.read({ sessionId: cp.sessionId ?? "", messageId: input.messageId })
      if (!read.ok) return read.error === "unknown_session" ? startInFreshSession(input, cp) : retryLater(read, cp)
      const snapshot = read.snapshot
      if (cp.workbot) await noteBackground(input, cp, snapshot)
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, failureText(snapshot.terminalError), now)
        cp.finalStatus = "suspended"
        cp.phase = "finish"
      } else if (finishedTurn(cp, snapshot)) {
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
    if (cp.workbot && input.live) {
      const feed = await input.live.acquire(cp.sessionId ?? "", cp.liveWindow)
      // A new connection can't know how much of the step being written it missed.
      if (!feed || feed.fresh) cp.liveStep = undefined
      return liveWindow(input, cp, feed)
    }
    const read = await input.runner.read({ sessionId: cp.sessionId ?? "", messageId: input.messageId })
    if (!read.ok) return read.error === "unknown_session" ? startInFreshSession(input, cp) : retryLater(read, cp)
    const outcome = await applyReply(input, cp, read.snapshot, read.snapshot.finalAssistantText)
    return { checkpoint: cp, delayMs: outcome === "quiet" ? QUIET_POLL_MS : outcome === "finish" ? 0 : 1_000 }
  }
  if (cp.phase === "watch") return { checkpoint: cp, delayMs: 0, done: true, watch: true }
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
  // A reaction alone is the whole reply: nobody needs a ping about it.
  const reactedOnly = cp.workbot && !cp.sentText && cp.finalStatus !== "suspended"
  // A quiet task's answer is a new reply, which already notifies; only a streamed reply needs the extra mention.
  if (
    (cp.live || cp.workbot) &&
    !reactedOnly &&
    cp.startedAt !== undefined &&
    cp.completedAt - cp.startedAt > DONE_PING_AFTER_MS &&
    cp.recipientUserId
  ) {
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
  if (cp.workbot && cp.taskIds.length > 0) {
    // The answer is done but work it started in the background isn't: watch for its reports, without holding the thread.
    cp.phase = "watch"
    cp.watchUntil = now() + WATCH_MAX_MS
    return { checkpoint: cp, delayMs: WATCH_POLL_MS, done: true, watch: true }
  }
  return { checkpoint: cp, delayMs: 0, done: true }
}

/** A turn that ended with an answer; with Workbot replies a turn that only reacted counts, though it wrote nothing. */
function finishedTurn(cp: Checkpoint, snapshot: SlackRunSnapshot) {
  return snapshot.status === "idle" && !snapshot.terminalError && (cp.workbot || Boolean(snapshot.finalAssistantText))
}

/** Remembers the background tasks the turn started, and puts its reaction on the person's message once. */
async function noteBackground(input: RunInput, cp: Checkpoint, snapshot: SlackRunSnapshot) {
  for (const task of snapshot.tasks) if (!cp.taskIds.includes(task.id)) cp.taskIds.push(task.id)
  if (cp.reacted || !snapshot.reaction) return
  cp.reacted = true
  const name = slackReactionName(snapshot.reaction.emoji)
  if (name && cp.reactTo) {
    try {
      await input.slack("reactions.add", { channel: cp.reactTo.channel, timestamp: cp.reactTo.ts, name })
    } catch (error) {
      // Installs from before reactions:write (missing_scope), a reaction already there: the answer goes on regardless.
      input.log?.("slack_assistant_reaction_failed", { code: error instanceof SlackApiError ? error.code : "reaction_failed" })
    }
  }
  await input.persist?.(cp)
}

/**
 * The text to show for a turn: what is stored, plus the step being written right now when its start was seen. The
 * live part is only ever extended, so what was posted stays a prefix of what the turn finally stores.
 */
export function liveReplyText(cp: Checkpoint, snapshot: SlackRunSnapshot) {
  const stored = snapshot.finalAssistantText
  if (snapshot.status === "idle" || cp.liveBlind || cp.liveStep !== snapshot.assistantTexts.length || !cp.liveText) return stored
  return stored ? `${stored}\n\n${cp.liveText}` : cp.liveText
}

/** Applies one runner text event to the live state. */
export function trackLiveText(cp: Checkpoint, event: { step: number; delta: string; reset?: boolean }) {
  if (cp.liveStep === undefined || event.step < cp.liveStep) return
  if (event.step > cp.liveStep) {
    // A new step: seen from its first word.
    cp.liveStep = event.step
    cp.liveText = event.reset ? "" : event.delta
    cp.liveBlind = false
    return
  }
  if (event.reset) {
    // The model call was retried and writes the step again from the start.
    cp.liveText = ""
    cp.liveBlind = false
    return
  }
  if (!cp.liveBlind) cp.liveText += event.delta
}

/**
 * What still has to be posted once the turn's text is final. Normally the rest after what was posted; if a retried
 * model call wrote a step differently from what was already streamed, the answer continues from the paragraph where
 * they part, so nothing is lost (that paragraph may show twice).
 */
export function catchUpText(sent: string, final: string) {
  if (final.startsWith(sent)) return final.slice(sent.length)
  let common = 0
  while (common < sent.length && common < final.length && sent[common] === final[common]) common += 1
  const paragraph = final.lastIndexOf("\n\n", common)
  const rest = final.slice(paragraph < 0 ? 0 : paragraph + 2).trim()
  return rest ? `\n\n${rest}` : ""
}

/**
 * Streams the reply for up to one window: live text from the runner's events (appended at most once a second), the
 * stored transcript re-read when the runner says it changed, and the end of the turn.
 */
async function liveWindow(input: RunInput, cp: Checkpoint, feed: LiveFeed | null): Promise<Step> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? wait
  const deadline = now() + (input.liveWindowMs ?? LIVE_WINDOW_MS)
  let snapshot: SlackRunSnapshot | null = null
  let lastRead = 0
  let lastRenew = now()
  let mustRead = true
  try {
    for (;;) {
      for (const event of feed?.take() ?? []) {
        if (event.messageId !== input.messageId) continue
        if (event.type === "text") trackLiveText(cp, event)
        else mustRead = true
      }
      if (mustRead || !snapshot || !feed || feed.closed || now() - lastRead >= LIVE_SAFETY_READ_MS) {
        const read = await input.runner.read({ sessionId: cp.sessionId ?? "", messageId: input.messageId })
        if (!read.ok) return read.error === "unknown_session" ? await startInFreshSession(input, cp) : retryLater(read, cp)
        snapshot = read.snapshot
        lastRead = now()
        mustRead = false
        if (cp.liveStep === undefined) {
          // Joined mid-turn: the step being written now is shown once stored; the next one live.
          cp.liveStep = snapshot.assistantTexts.length
          cp.liveText = ""
          cp.liveBlind = true
        }
      }
      const outcome = await applyReply(input, cp, snapshot, liveReplyText(cp, snapshot))
      if (outcome === "quiet") return { checkpoint: cp, delayMs: QUIET_POLL_MS }
      if (outcome === "finish") return { checkpoint: cp, delayMs: 0 }
      if (now() >= deadline) return { checkpoint: cp, delayMs: 0 }
      if (now() - lastRenew >= 10_000) {
        await input.renew?.()
        lastRenew = now()
      }
      await sleep(Math.max(0, Math.min(LIVE_FLUSH_MS, deadline - now())))
    }
  } finally {
    cp.liveWindow += 1
    feed?.release(cp.liveWindow)
  }
}

/**
 * Shows one read of the turn in a reply that streams: the new text, step lines, and the end of the turn. Returns
 * "quiet" when a long task stops streaming here, "finish" when the turn ended.
 */
async function applyReply(input: RunInput, cp: Checkpoint, snapshot: SlackRunSnapshot, text: string) {
  const now = input.now ?? Date.now
  const quietAfterMs = input.quietAfterMs ?? LONG_TASK_QUIET_AFTER_MS
  if (cp.workbot) await noteBackground(input, cp, snapshot)
  const finished = finishedTurn(cp, snapshot)
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
    return "quiet"
  }
  // Once the turn ended its stored text is final: post whatever of it is missing, even after a retried step.
  const delta = cp.workbot && (finished || snapshot.terminalError) ? catchUpText(cp.sentText, text) : currentReplyDelta(cp.sentText, text)
  if (delta)
    await appendText(input.slack, cp, delta, now, async (part) => {
      cp.sentText += part
      cp.firstTextAt ??= now()
      await input.persist?.(cp)
    })
  // Step lines are what "Show progress while working" turns on; Workbot-style text streams either way.
  if (cp.live) await sendStepUpdates(input.slack, cp, snapshot.steps, now, input.persist)
  const noAnswerYet = !cp.sentText && !text
  if (cp.live && noAnswerYet && !cp.stillWorkingShown && cp.startedAt !== undefined && now() - cp.startedAt > STILL_WORKING_AFTER_MS) {
    await appendText(input.slack, cp, STILL_WORKING_LINE, now)
    cp.stillWorkingShown = true
    await input.persist?.(cp)
  }
  if (snapshot.terminalError) {
    await appendText(input.slack, cp, `\n\n${failureText(snapshot.terminalError)}`, now)
    cp.finalStatus = "suspended"
    cp.phase = "finish"
    return "finish"
  }
  if (finished) {
    cp.phase = "finish"
    return "finish"
  }
  return "continue"
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

/** Keeps @here, @channel and group mentions in model text from notifying anyone. */
function withoutBroadcasts(text: string) {
  return text
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/gi, "@\u200b$1")
    .replace(/<!subteam\^[^>]*>/gi, "@\u200bgroup")
    .replace(/@(here|channel|everyone)\b/gi, "@\u200b$1")
}

/** Characters of a report shown in its reply (Slack allows 12,000 across markdown blocks). */
const REPORT_LIMIT = 11_000

/**
 * A message whose answer is done but whose background tasks still run: resumes any that were interrupted, and posts
 * each task's report as a new reply mentioning the person, once, where the answer went. Done when every task stopped
 * or reported, or after a day.
 */
export async function advanceSlackWatch(input: {
  checkpoint: Checkpoint
  runner: SlackRunner
  slack: SlackCall
  messageId: string
  persist?: (checkpoint: Checkpoint) => Promise<void>
  now?: () => number
}): Promise<Step> {
  const cp = input.checkpoint
  const now = input.now ?? Date.now
  const done = { checkpoint: cp, delayMs: 0, done: true }
  if (!cp.sessionId || now() >= (cp.watchUntil ?? 0)) return done
  const background = await input.runner.background({ sessionId: cp.sessionId, messageId: input.messageId })
  if (!background.ok) return background.error === "unknown_session" || !background.retryable ? done : { checkpoint: cp, delayMs: WATCH_POLL_MS }
  const titles = new Map(background.tasks.map((task) => [task.id, task.title]))
  const mention = cp.recipientUserId && /^[UW][A-Z0-9]{2,}$/.test(cp.recipientUserId) ? `<@${cp.recipientUserId}>` : ""
  for (const report of background.reports) {
    if (cp.reported.includes(report.id) || !TERMINAL_STATUSES.has(report.status)) continue
    if (report.status === "completed") {
      const written = await input.runner.turnText({ sessionId: cp.sessionId, messageId: report.id })
      if (!written.ok) {
        if (written.retryable) continue
      } else if (written.text.trim()) {
        const text = withoutBroadcasts(written.text.trim())
        await input.slack("chat.postMessage", {
          channel: cp.channel,
          thread_ts: cp.threadTs,
          // The notification and fallback text; the blocks carry the report in Markdown.
          text: `${mention} ${slackSafeText(excerpt(written.text, 300))}`.trim(),
          blocks: [
            ...(mention ? [{ type: "section", text: { type: "mrkdwn", text: mention } }] : []),
            { type: "markdown", text: text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT - 1)}…` : text },
          ],
          unfurl_links: false,
          unfurl_media: false,
        })
      }
    } else if (report.status === "failed") {
      const title = titles.get(report.task) || report.title
      await input.slack("chat.postMessage", {
        channel: cp.channel,
        thread_ts: cp.threadTs,
        text: `${mention} I couldn't bring back the result of ${title ? `"${slackSafeText(title)}"` : "the background task"}. Ask me about it here.`.trim(),
      })
    }
    cp.reported.push(report.id)
    await input.persist?.(cp)
  }
  const reportOf = new Map(background.reports.map((report) => [report.task, report.id]))
  const settled = background.tasks.every((task) => {
    const report = reportOf.get(task.id)
    return task.status === "aborted" || (report !== undefined && cp.reported.includes(report))
  })
  return settled ? done : { checkpoint: cp, delayMs: WATCH_POLL_MS }
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "aborted"])

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
  cp.liveStep = undefined
  cp.liveText = ""
  cp.taskIds = []
  await input.persist?.(cp)
  return { checkpoint: cp, delayMs: 0 }
}
