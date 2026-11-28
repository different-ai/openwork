import { z } from "zod"
import { composeSlackMessages, markdownToSlackParts, postSlackMessage, type SlackComposeOptions, type SlackOutgoingMessage } from "./rich-message.js"
import { excerpt, markdownToPlainText, slackSafeText, splitSlackText, withoutSlackBroadcasts } from "./slack-text.js"
import type { RunnerFailure, SlackRunner, SlackRunSnapshot, SlackRunStep, SlackSessionSettings } from "./headless.js"
import type { LiveFeed, LiveFeedSource } from "./live.js"
import { scopeKey, slackReactionName, SlackApiError, type SlackCall } from "./protocol.js"
export const checkpointSchema = z.object({
  phase: z.enum(["create", "send", "read", "finish", "watch"]).default("create"),
  channel: z.string().optional(),
  threadTs: z.string().optional(),
  streamTs: z.string().optional(),
  sessionId: z.string().optional(),
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
  quiet: z.boolean().default(false),
  lastCheckInAt: z.number().optional(),
  queuedNoticeShown: z.boolean().default(false),
  live: z.boolean().default(true),
  sessionResets: z.number().default(0),
  workbot: z.boolean().default(false),
  driveFiles: z.boolean().default(false),
  answerReply: z.boolean().default(false),
  answerText: z.string().optional(),
  answerPartsPosted: z.number().default(0),
  rich: z.boolean().default(false),
  reactTo: z.object({ channel: z.string(), ts: z.string() }).optional(),
  reacted: z.boolean().default(false),
  liveWindow: z.number().default(0),
  liveStep: z.number().optional(),
  liveText: z.string().default(""),
  liveBlind: z.boolean().default(false),
  taskIds: z.array(z.string()).default([]),
  reported: z.array(z.string()).default([]),
  watchUntil: z.number().optional(),
})
export type Checkpoint = z.infer<typeof checkpointSchema>

export const DONE_PING_AFTER_MS = 60_000
export const STILL_WORKING_AFTER_MS = 20_000
export const STILL_WORKING_LINE = "Still working on it. I'll reply here when it's done.\n\n"

export const LONG_TASK_QUIET_AFTER_MS = 4 * 60_000
export const LONG_TASK_LINE =
  "This one will take a while. I'll keep working and post the result here when I'm done. Press Stop to cancel."
export const CHECK_IN_EVERY_MS = 60 * 60_000
const QUIET_POLL_MS = 5_000
const NOT_LIVE_POLL_MS = 3_000
export const QUEUED_LINE = "Got it. I'll do this right after the current task. Press Stop to end that task and start this now."

export function formatElapsed(ms: number) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

function failureText(terminalError: { code: string }) {
  return terminalError.code === "stuck_repeating"
    ? "I got stuck repeating the same step, so I stopped. Try again, or ask in a different way."
    : "This task couldn't finish. Try again, or ask in a different way."
}

function isHeadingLine(raw: string, cleaned: string) {
  if (/^\s*#{1,6}\s/.test(raw)) return true
  if (/^[>*\-\s]*(\*\*|__)[^*_]+(\*\*|__)\W*$/.test(raw)) return true
  return cleaned.endsWith(":") && cleaned.length <= 60
}

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
  return current.startsWith(previous) ? current.slice(previous.length) : ""
}
export const STREAM_ROTATE_AFTER_MS = 4 * 60_000
export const STREAM_CHARACTER_LIMIT = 11_000
const STREAM_PART_CHARACTERS = 8_000
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

function streamFullOrClosed(error: unknown) {
  return streamClosedBySlack(error) || (error instanceof SlackApiError && error.code === "msg_too_long")
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

async function sendChunks(slack: SlackCall, checkpoint: Checkpoint, chunks: Chunk[], now: () => number) {
  if (!checkpoint.streamTs) return startStream(slack, checkpoint, chunks, now)
  const size = chunkText(chunks).length
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
    if (!streamFullOrClosed(error)) throw error
    if (!streamClosedBySlack(error)) await slack("chat.stopStream", { channel: checkpoint.channel, ts: checkpoint.streamTs, session_status: "processing" }).catch(() => undefined)
    await startStream(slack, checkpoint, [continued(), ...chunks], now)
  }
}

export async function stopSlackStream(slack: SlackCall, checkpoint: Checkpoint, extra: Record<string, unknown> = {}) {
  await closeStream(slack, checkpoint, checkpoint.finalStatus, extra)
}

async function closeStream(
  slack: SlackCall,
  checkpoint: Checkpoint,
  status: "active" | "suspended" | "processing",
  extra: Record<string, unknown> = {},
) {
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
  for (let offset = 0; offset < text.length; offset += STREAM_PART_CHARACTERS) {
    const part = text.slice(offset, offset + STREAM_PART_CHARACTERS)
    await sendChunks(slack, checkpoint, [{ type: "markdown_text", text: part }], now)
    await onPart?.(part)
  }
}
export const LIVE_WINDOW_MS = 20_000
export const LIVE_FLUSH_MS = 1_000
const LIVE_SAFETY_READ_MS = 3_000
export const WATCH_POLL_MS = 10_000
export const WATCH_MAX_MS = 24 * 60 * 60_000

type RunInput = {
  checkpoint: Checkpoint
  runner: SlackRunner
  slack: SlackCall
  messageId: string
  saveSession: (sessionId: string) => Promise<void>
  clearSession: () => Promise<void>
  title: string
  persist?: (checkpoint: Checkpoint) => Promise<void>
  model?: string
  quietAfterMs?: number
  settings?: SlackSessionSettings
  live?: LiveFeedSource
  renew?: () => Promise<void>
  richOptions?: SlackRichOptions
  log?: (message: string, fields: Record<string, string>) => void
  liveWindowMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export type SlackRichOptions = Pick<SlackComposeOptions, "places" | "imageUrl">

type Step = { checkpoint: Checkpoint; delayMs: number; done?: boolean; watch?: boolean }

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function advanceSlackRun(input: RunInput): Promise<Step> {
  const cp = input.checkpoint
  const now = input.now ?? Date.now
  if (cp.phase === "create") {
    if (!cp.sessionId) {
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
      if (snapshot.terminalError) {
        await appendText(input.slack, cp, failureText(snapshot.terminalError), now)
        cp.finalStatus = "suspended"
        cp.phase = "finish"
      } else if (finishedTurn(cp, snapshot)) {
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
      } else if (finishedTurn(cp, snapshot) && cp.answerReply) {
        cp.answerText = notesAndAnswer(snapshot, true).answer || snapshot.lastAssistantText
        cp.phase = "finish"
      } else if (finishedTurn(cp, snapshot)) {
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
  cp.prompt = undefined
  const feedback = feedbackBlock(input.messageId)
  if (cp.answerReply && cp.answerText) {
    await postAnswer(input, cp, feedback)
    await stopSlackStream(input.slack, cp)
  } else await stopSlackStream(input.slack, cp, { blocks: [feedback] })
  const reactedOnly = cp.workbot && !cp.sentText && cp.finalStatus !== "suspended"
  if (
    (cp.live || cp.workbot) &&
    !(cp.answerReply && cp.finalStatus !== "suspended") &&
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
    }
  }
  if (cp.workbot && cp.taskIds.length > 0) {
    cp.phase = "watch"
    cp.watchUntil = now() + WATCH_MAX_MS
    return { checkpoint: cp, delayMs: WATCH_POLL_MS, done: true, watch: true }
  }
  return { checkpoint: cp, delayMs: 0, done: true }
}

function finishedTurn(cp: Checkpoint, snapshot: SlackRunSnapshot) {
  return snapshot.status === "idle" && !snapshot.terminalError && (cp.workbot || Boolean(snapshot.finalAssistantText))
}

export function notesAndAnswer(snapshot: SlackRunSnapshot, finished: boolean) {
  const written = snapshot.assistantTexts.flatMap((text, index) =>
    text.trim() ? [{ text: text.trim(), worked: snapshot.assistantWorked[index] === true }] : [],
  )
  const last = written.at(-1)
  const notes = written.flatMap((entry) => (entry.worked ? [entry.text] : [])).join("\n\n")
  const answer = !finished ? "" : last ? (last.worked ? "" : last.text) : snapshot.lastAssistantText.trim()
  return { notes, answer }
}

function feedbackBlock(messageId: string) {
  return {
    type: "context_actions",
    elements: [
      {
        type: "feedback_buttons",
        action_id: `slack_feedback:${messageId.replace(/^msg_/, "")}`,
        positive_button: { text: { type: "plain_text", text: "Helpful" }, value: "positive" },
        negative_button: { text: { type: "plain_text", text: "Needs work" }, value: "negative" },
      },
    ],
  }
}

const ANSWER_LIMIT = 11_000

function richMessages(markdown: string, cp: Checkpoint, options: SlackRichOptions, log?: RunInput["log"]): SlackOutgoingMessage[] {
  const { parts, invalidDirectives } = markdownToSlackParts(markdown, { directives: true })
  if (invalidDirectives) log?.("slack_rich_component_invalid", { count: String(invalidDirectives) })
  return composeSlackMessages(parts, { ...options, choiceFor: cp.recipientUserId, reservedBlocks: 1 })
}

async function postRichAnswer(input: RunInput, cp: Checkpoint, options: SlackRichOptions, feedback: Record<string, unknown>) {
  const messages = richMessages(cp.answerText ?? "", cp, options, input.log)
  const last = messages.reduce((found, message, index) => (message.choice ? found : index), -1)
  for (const [index, message] of messages.entries()) {
    if (index < cp.answerPartsPosted) continue
    await postSlackMessage(input.slack, { channel: cp.channel, thread_ts: cp.threadTs }, message, {
      after: index === last ? [feedback] : [],
      onRejected: (code) => input.log?.("slack_rich_message_rejected", { surface: "answer", code }),
    })
    cp.answerPartsPosted = index + 1
    await input.persist?.(cp)
  }
}

async function postAnswer(input: RunInput, cp: Checkpoint, feedback: Record<string, unknown>) {
  if (cp.rich && input.richOptions) return postRichAnswer(input, cp, input.richOptions, feedback)
  const parts = splitSlackText(withoutSlackBroadcasts(cp.answerText ?? ""), ANSWER_LIMIT)
  for (const [index, part] of parts.entries()) {
    if (index < cp.answerPartsPosted) continue
    await input.slack("chat.postMessage", {
      channel: cp.channel,
      thread_ts: cp.threadTs,
      text: slackSafeText(excerpt(markdownToPlainText(part), 300)),
      blocks: [{ type: "markdown", text: part }, ...(index === parts.length - 1 ? [feedback] : [])],
      unfurl_links: false,
      unfurl_media: false,
    })
    cp.answerPartsPosted = index + 1
    await input.persist?.(cp)
  }
}

async function noteBackground(input: RunInput, cp: Checkpoint, snapshot: SlackRunSnapshot) {
  for (const task of snapshot.tasks) if (!cp.taskIds.includes(task.id)) cp.taskIds.push(task.id)
  if (cp.reacted || !snapshot.reaction) return
  cp.reacted = true
  const name = slackReactionName(snapshot.reaction.emoji)
  if (name && cp.reactTo) {
    try {
      await input.slack("reactions.add", { channel: cp.reactTo.channel, timestamp: cp.reactTo.ts, name })
    } catch (error) {
      input.log?.("slack_assistant_reaction_failed", { code: error instanceof SlackApiError ? error.code : "reaction_failed" })
    }
  }
  await input.persist?.(cp)
}

export function liveReplyText(cp: Checkpoint, snapshot: SlackRunSnapshot) {
  const stored = snapshot.finalAssistantText
  if (snapshot.status === "idle" || cp.liveBlind || cp.liveStep !== snapshot.assistantTexts.length || !cp.liveText) return stored
  return stored ? `${stored}\n\n${cp.liveText}` : cp.liveText
}

export function trackLiveText(cp: Checkpoint, event: { step: number; delta: string; reset?: boolean }) {
  if (cp.liveStep === undefined || event.step < cp.liveStep) return
  if (event.step > cp.liveStep) {
    cp.liveStep = event.step
    cp.liveText = event.reset ? "" : event.delta
    cp.liveBlind = false
    return
  }
  if (event.reset) {
    cp.liveText = ""
    cp.liveBlind = false
    return
  }
  if (!cp.liveBlind) cp.liveText += event.delta
}

export function catchUpText(sent: string, final: string) {
  if (final.startsWith(sent)) return final.slice(sent.length)
  let common = 0
  while (common < sent.length && common < final.length && sent[common] === final[common]) common += 1
  const paragraph = final.lastIndexOf("\n\n", common)
  const rest = final.slice(paragraph < 0 ? 0 : paragraph + 2).trim()
  return rest ? `\n\n${rest}` : ""
}

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

async function applyReply(input: RunInput, cp: Checkpoint, snapshot: SlackRunSnapshot, text: string) {
  const now = input.now ?? Date.now
  const quietAfterMs = input.quietAfterMs ?? LONG_TASK_QUIET_AFTER_MS
  if (cp.workbot) await noteBackground(input, cp, snapshot)
  const finished = finishedTurn(cp, snapshot)
  if (!snapshot.terminalError && !finished && cp.startedAt !== undefined && now() - cp.startedAt >= quietAfterMs) {
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
  const split = cp.answerReply ? notesAndAnswer(snapshot, finished) : null
  if (split && finished) cp.answerText = split.answer
  const delta = split
    ? currentReplyDelta(cp.sentText, split.notes)
    : cp.workbot && (finished || snapshot.terminalError)
      ? catchUpText(cp.sentText, text)
      : currentReplyDelta(cp.sentText, text)
  if (delta)
    await appendText(input.slack, cp, delta, now, async (part) => {
      cp.sentText += part
      cp.firstTextAt ??= now()
      await input.persist?.(cp)
    })
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

const REPORT_LIMIT = 11_000

export async function advanceSlackWatch(input: {
  checkpoint: Checkpoint
  runner: SlackRunner
  slack: SlackCall
  messageId: string
  persist?: (checkpoint: Checkpoint) => Promise<void>
  richOptions?: SlackRichOptions
  log?: (message: string, fields: Record<string, string>) => void
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
      } else if (written.text.trim() && cp.rich && input.richOptions) {
        const messages = richMessages(written.text.trim(), cp, input.richOptions, input.log)
        for (const [index, message] of messages.entries()) {
          const partId = `${report.id}#${index}`
          if (messages.length > 1 && cp.reported.includes(partId)) continue
          const first = index === 0 && Boolean(mention)
          await postSlackMessage(input.slack, { channel: cp.channel, thread_ts: cp.threadTs }, message, {
            before: first ? [{ type: "section", text: { type: "mrkdwn", text: mention } }] : [],
            textPrefix: first ? `${mention} ` : "",
            onRejected: (code) => input.log?.("slack_rich_message_rejected", { surface: "report", code }),
          })
          if (messages.length > 1) {
            cp.reported.push(partId)
            await input.persist?.(cp)
          }
        }
      } else if (written.text.trim()) {
        const parts = splitSlackText(withoutSlackBroadcasts(written.text.trim()), REPORT_LIMIT)
        for (const [index, part] of parts.entries()) {
          const partId = `${report.id}#${index}`
          if (parts.length > 1 && cp.reported.includes(partId)) continue
          const notification = slackSafeText(excerpt(markdownToPlainText(index === 0 ? written.text : part), 300))
          await input.slack("chat.postMessage", {
            channel: cp.channel,
            thread_ts: cp.threadTs,
            text: index === 0 ? `${mention} ${notification}`.trim() : notification,
            blocks: [
              ...(index === 0 && mention ? [{ type: "section", text: { type: "mrkdwn", text: mention } }] : []),
              { type: "markdown", text: part },
            ],
            unfurl_links: false,
            unfurl_media: false,
          })
          if (parts.length > 1) {
            cp.reported.push(partId)
            await input.persist?.(cp)
          }
        }
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
  constructor(readonly runnerError?: string) {
    super("remote_session_unavailable")
  }
}

function retryLater(result: RunnerFailure, cp: Checkpoint) {
  if (!result.retryable) throw new RemoteSessionUnavailableError(result.error)
  return {
    checkpoint: cp,
    delayMs: typeof result.retryAfterMs === "number" ? Math.max(1_000, Math.min(60_000, result.retryAfterMs)) : 5_000,
  }
}

async function startInFreshSession(input: { clearSession: () => Promise<void>; persist?: (checkpoint: Checkpoint) => Promise<void> }, cp: Checkpoint) {
  if (cp.sessionResets >= 1 || !cp.prompt) throw new RemoteSessionUnavailableError("unknown_session")
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
