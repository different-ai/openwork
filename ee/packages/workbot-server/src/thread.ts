import type { RunnerMessage, RunnerSnapshot, RunnerTurn } from "@openwork-ee/headless-protocol"

/**
 * Workbot is one conversation per person. The runner keeps the transcript;
 * this module turns it into what the person sees: their message (with
 * Workbot's emoji reaction, if it reacted), then its answer as it happened.
 * Work behind the answer is told the way a colleague would say it, and only
 * while it happens: "Searching Slack", "Using my computer". Tool names,
 * notes to self, models and raw errors never reach the page. Bigger jobs
 * run as background tasks out of sight; each comes back as Workbot's own
 * message (a report), with the files the task made.
 */

/** Runner message ids for Workbot turns are the page's own ids with this prefix. */
export const WORKBOT_MESSAGE_PREFIX = "wb_"

/** The turn in which Workbot says hello first, on the person's first visit: one per conversation. */
export const GREETING_RUNNER_ID = `${WORKBOT_MESSAGE_PREFIX}hello`

/** Whether a runner message id is Workbot's first hello (it runs with a token that can only read). */
export function isGreetingRunnerId(messageId: string | undefined) {
  return messageId === GREETING_RUNNER_ID
}

/**
 * Workbot ends its hello with "Next: a | b | c": the things the person could ask next, shown as buttons. Returns
 * the text without that line, and the suggestions.
 */
export function splitSuggestions(text: string): { text: string; suggestions: string[] } {
  const lines = text.trimEnd().split("\n")
  const last = lines.at(-1)?.trim() ?? ""
  const match = /^\**next:?\**\s*:?\s*(.+)$/i.exec(last)
  if (!match?.[1]) return { text, suggestions: [] }
  const suggestions = match[1]
    .split("|")
    .map((entry) => entry.replace(/^[\s"“*-]+|[\s"”*.]+$/g, ""))
    .filter((entry) => entry.length > 0 && entry.length <= 60)
    .slice(0, 3)
  return { text: lines.slice(0, -1).join("\n").trimEnd(), suggestions }
}

export type WorkbotTurnStatus = "queued" | "working" | "done" | "failed" | "stopped"
/** A file in the conversation; `updatedAt` changes when Workbot revises it in place. */
export type WorkbotAttachment = { id: string; name: string; mediaType: string; size: number; updatedAt?: number }
/**
 * Something Workbot did that a colleague would mention while doing it: work in one of the person's apps, or on its
 * own computer. The page shows only the one in progress; finished work speaks through the answer.
 */
export type WorkbotStep = {
  /** What it is doing, as a colleague would say it: "Searching Slack", "Using my computer". */
  label: string
  /** What the leading slot shows: the connected app's logo, or Workbot's computer. */
  icon: "app" | "computer"
  status: "running" | "done"
  /** The connected app it used, when known (for its logo). */
  app: string | null
  startedAt: number | null
  finishedAt: number | null
  /** What it did, in its own plain words: the updates it gave while working on its computer. */
  updates: string[]
}
export type WorkbotPart = { kind: "text"; text: string } | { kind: "steps"; steps: WorkbotStep[] }

/**
 * A bigger job this message handed to a background task: the page keeps it in view where it started, so the person
 * can see it is still going (and stop it) until it reports back.
 */
export type WorkbotTask = {
  id: string
  title: string
  status: "queued" | "working" | "paused" | "done" | "failed" | "stopped"
  startedAt: number | null
  finishedAt: number | null
  /** What it is doing now, in its own plain words (its latest update from its computer), while it works. */
  update: string | null
  /** Everything it said it did on its computer, oldest first, kept after it is over. */
  updates: string[]
}

export type WorkbotTurn = {
  id: string
  text: string
  sentAt: number | null
  finishedAt: number | null
  status: WorkbotTurnStatus
  /** Files sent with the message. */
  attachments: WorkbotAttachment[]
  /** Files Workbot made for the person while answering, oldest first, to open from the answer. */
  outputs: WorkbotAttachment[]
  /** The one emoji Workbot reacted to this message with, as a colleague does in chat. */
  reaction: string | null
  /** Text and steps in the order they happened. */
  parts: WorkbotPart[]
  /**
   * How many model calls are stored. Live text streamed for call N belongs after these parts while
   * N >= modelSteps; once stored, it is part of `parts`.
   */
  modelSteps: number
  error: string | null
  /** Background tasks this message started, oldest first. */
  tasks: WorkbotTask[]
  /** Workbot's first hello: it spoke first, so there is no message from the person above it. */
  greeting: boolean
  /** Things the person could ask next, offered as buttons under Workbot's hello. */
  suggestions: string[]
}

const ACTIVE = new Set(["queued", "running"])

const TASK_STATUS: Record<string, WorkbotTask["status"]> = {
  queued: "queued",
  running: "working",
  interrupted: "paused",
  completed: "done",
  failed: "failed",
  aborted: "stopped",
}

function tasksOf(snapshot: RunnerSnapshot, parent: string, byTurn: Map<string, RunnerMessage[]>): WorkbotTask[] {
  return snapshot.turns
    .filter((entry) => entry.kind === "task" && entry.parent === parent)
    .map((entry) => {
      const status = TASK_STATUS[entry.status] ?? "working"
      const open = status === "queued" || status === "working" || status === "paused"
      // Its plain-language updates: the description it gave each command on its computer.
      const updates = (byTurn.get(entry.messageId) ?? [])
        .flatMap((message) => (message.role === "assistant" ? message.toolCalls : []))
        .filter((call) => COMPUTER_TOOLS.has(call.name) && typeof call.input.description === "string" && call.input.description.trim())
        .map((call) => String(call.input.description).trim())
      const update = open ? (updates.at(-1) ?? null) : null
      return {
        id: entry.messageId.slice(WORKBOT_MESSAGE_PREFIX.length),
        title: entry.title ?? "Background task",
        status,
        startedAt: entry.createdAt ?? null,
        finishedAt: open ? null : (entry.updatedAt ?? null),
        update,
        updates,
      }
    })
}

function friendlyError(code: string | null): string {
  if (!code) return "Something went wrong. Try again."
  if (code.startsWith("model_")) return "I couldn't reach the AI model just now. Try again in a moment."
  if (code === "mcp_unavailable") return "I couldn't reach your connected apps just now. Try again in a moment."
  if (code === "turn_timeout") return "That took too long, so I stopped."
  if (code === "max_steps_exceeded") return "That needed more steps than I can take at once. Try a smaller piece of it."
  if (code === "stuck_repeating") return "I kept getting the same result, so I stopped. Try asking a different way."
  return "Something went wrong. Try again."
}

const APPS: Array<[RegExp, string]> = [
  [/slack/i, "Slack"],
  [/gmail|mail/i, "Gmail"],
  [/calendar|gcal/i, "Google Calendar"],
  [/drive|docs|sheets/i, "Google Drive"],
  [/notion/i, "Notion"],
  [/linear/i, "Linear"],
  [/github/i, "GitHub"],
  [/outlook|microsoft|teams|onedrive|sharepoint/i, "Microsoft 365"],
  [/hubspot/i, "HubSpot"],
  [/salesforce/i, "Salesforce"],
  [/jira|confluence|atlassian/i, "Atlassian"],
]

/** What it is doing in a connected app, as a colleague would say it (DESIGN C4). */
const APP_ACTIONS: Array<[RegExp, (app: string) => string]> = [
  [/search|find|query|lookup/, (app) => `Searching ${app}`],
  [/draft/, (app) => `Drafting in ${app}`],
  [/send|post|reply|chat_?message|message/, (app) => `Sending in ${app}`],
  [/create|add|insert|schedule/, (app) => `Adding to ${app}`],
  [/update|edit|patch|move|rename/, (app) => `Updating ${app}`],
  [/delete|remove|archive|trash/, (app) => `Removing from ${app}`],
  [/list|get|read|fetch|retrieve|view|show|events|history/, (app) => `Checking ${app}`],
]

function appActionLabel(app: string, capability: string) {
  const action = capability.split(/[:/]/).pop()?.toLowerCase() ?? ""
  return APP_ACTIONS.find(([pattern]) => pattern.test(action))?.[1](app) ?? `Looking in ${app}`
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The emoji of a `react` call, if it is exactly one (the runner checks too; the page never shows anything else). */
function reactionOf(input: Record<string, unknown>): string | null {
  const emoji = typeof input.emoji === "string" ? input.emoji.trim() : ""
  if (!emoji || emoji.length > 32 || [...graphemes.segment(emoji)].length !== 1) return null
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji) ? emoji : null
}

function appOf(name: string, input: Record<string, unknown>): string | null {
  const target = name === "execute_capability" && typeof input.name === "string" ? input.name : name
  return APPS.find(([pattern]) => pattern.test(target))?.[1] ?? null
}

/** The conversation's kept files, so the ones Workbot made show under the answer that made them. */
export type FileNames = ReadonlyMap<string, { name: string; createdAt: number; updatedAt?: number; mediaType?: string; size?: number; source?: "user" | "agent" }>

const COMPUTER_TOOLS: ReadonlySet<string> = new Set(["bash", "look"])

/**
 * Work on Workbot's computer reads as one step, however many commands it took: the person sees that it is using
 * its computer, never commands, retries or failures it recovered from (DESIGN C3, T2). What it is doing, in its
 * own words, travels in `updates`; the page shows the newest one under the step.
 */
function addComputerStep(parts: WorkbotPart[], input: Record<string, unknown>, result: RunnerMessage | undefined, at: number | null) {
  const running = result === undefined
  const doing = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 80) : null
  const last = parts.at(-1)
  const previous = last?.kind === "steps" ? last.steps.at(-1) : undefined
  const step: WorkbotStep =
    previous?.icon === "computer" ? previous : { label: "Using my computer", icon: "computer", status: "done", app: null, startedAt: at, finishedAt: null, updates: [] }
  if (doing && step.updates.at(-1) !== doing) step.updates.push(doing)
  // The time it actually worked: a command cut off by a restart or a sleeping laptop says nothing about the work.
  const before = workedMs.get(step) ?? 0
  const ended = result?.createdAt ?? null
  const took = at !== null && ended !== null ? Math.max(0, ended - at) : 0
  const worked = before + (took <= LONGEST_COMMAND_MS ? took : 0)
  workedMs.set(step, worked)
  step.status = running ? "running" : "done"
  // Duration is shown as finishedAt − startedAt, and a running step counts up from startedAt.
  if (running) {
    step.startedAt = at === null ? step.startedAt : at - before
    step.finishedAt = null
  } else if (ended !== null) {
    step.startedAt = ended - worked
    step.finishedAt = ended
  }
  if (step === previous) return
  if (last?.kind === "steps") last.steps.push(step)
  else parts.push({ kind: "steps", steps: [step] })
}

const workedMs = new WeakMap<WorkbotStep, number>()

/**
 * One command runs at most 5 minutes on the computer; a call that took far longer was stalled or interrupted
 * (a restart, a sleeping laptop), so its time is not counted as work.
 */
const LONGEST_COMMAND_MS = 6 * 60_000

function statusOf(turn: RunnerTurn): WorkbotTurnStatus {
  if (turn.status === "queued") return "queued"
  // An interrupted turn is resumed by the next read, so the person sees it still working.
  if (turn.status === "running" || turn.status === "interrupted") return "working"
  if (turn.status === "completed") return "done"
  if (turn.status === "aborted") return "stopped"
  return "failed"
}

/** Files Workbot made or revised while a turn ran: they belong under that answer, each once, at its latest version. */
function outputsOf(files: FileNames, startedAt: number | null, finishedAt: number | null): WorkbotAttachment[] {
  if (startedAt === null) return []
  const until = finishedAt === null ? Number.POSITIVE_INFINITY : finishedAt + 1_000
  const during = (at: number) => at >= startedAt && at <= until
  const made = [...files.entries()]
    .filter(([, file]) => file.source === "agent" && (during(file.createdAt) || (file.updatedAt !== undefined && during(file.updatedAt))))
    .sort(([, a], [, b]) => a.createdAt - b.createdAt)
  // Older runs saved each revision as its own file; the newest one under a name stands for them all.
  const latest = new Map(
    made.map(([id, file]) => [file.name, { id, name: file.name, mediaType: file.mediaType ?? "application/octet-stream", size: file.size ?? 0, updatedAt: file.updatedAt ?? file.createdAt }]),
  )
  return [...latest.values()]
}

export function buildWorkbotTurns(snapshot: RunnerSnapshot, files: FileNames = new Map()): WorkbotTurn[] {
  const byTurn = new Map<string, RunnerMessage[]>()
  for (const message of snapshot.messages) {
    if (!message.messageId) continue
    const list = byTurn.get(message.messageId) ?? []
    list.push(message)
    byTurn.set(message.messageId, list)
  }

  const turns: WorkbotTurn[] = []
  for (const turn of snapshot.turns) {
    // A background task's own work stays out of the conversation; its report shows instead.
    if (!turn.messageId.startsWith(WORKBOT_MESSAGE_PREFIX) || turn.kind === "task") continue
    const messages = byTurn.get(turn.messageId) ?? []
    const user = messages.find((message) => message.role === "user")
    // Queued follow-ups join the transcript only when they start; the page shows its own copy until then.
    if (!user || user.role !== "user") continue
    const results = new Map(messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message] as const] : [])))

    const parts: WorkbotPart[] = []
    let reaction: string | null = null
    let modelSteps = 0
    const greeting = isGreetingRunnerId(turn.messageId)
    for (const message of messages) {
      if (message.role !== "assistant") continue
      modelSteps += 1
      const text = message.text.trim()
      // Workbot's hello is one finished message: what it said to itself between lookups ("retrying that") stays out.
      if (text && !(greeting && message.toolCalls.length > 0)) {
        const last = parts.at(-1)
        if (last?.kind === "text") last.text = `${last.text}\n\n${text}`
        else parts.push({ kind: "text", text })
      }
      for (const call of message.toolCalls) {
        if (call.name === "react") {
          const result = results.get(call.id)
          const emoji = reactionOf(call.input)
          if (emoji && !(result?.role === "tool" && result.isError)) reaction = emoji
          continue
        }
        if (COMPUTER_TOOLS.has(call.name)) {
          addComputerStep(parts, call.input, results.get(call.id), message.createdAt ?? null)
          continue
        }
        // Only work in a connected app is worth a line ("Searching Slack"); lookups, notes to self and files stay
        // out of sight: files it made show as cards under the answer.
        const app = call.name === "execute_capability" ? appOf(call.name, call.input) : null
        if (!app) continue
        const result = results.get(call.id)
        const step: WorkbotStep = {
          label: appActionLabel(app, String(call.input.name ?? "")),
          icon: "app",
          status: result === undefined ? "running" : "done",
          app,
          startedAt: message.createdAt ?? null,
          finishedAt: result?.createdAt ?? null,
          updates: [],
        }
        const last = parts.at(-1)
        if (last?.kind === "steps") last.steps.push(step)
        else parts.push({ kind: "steps", steps: [step] })
      }
    }

    const status = statusOf(turn)
    const working = status === "working" || status === "queued"
    // Workbot's hello: the prompt that asked for it stays hidden, and its closing "Next:" line becomes buttons.
    let suggestions: string[] = []
    if (greeting && !working) {
      const last = [...parts].reverse().find((part) => part.kind === "text")
      if (last?.kind === "text") {
        const split = splitSuggestions(last.text)
        last.text = split.text
        suggestions = split.suggestions
      }
    }
    const outputs = outputsOf(files, turn.createdAt ?? null, working ? null : (turn.updatedAt ?? null))
    // A report is Workbot speaking first: the task's notes to it stay hidden, and it brings back what the task made.
    const task = turn.kind === "report" ? snapshot.turns.find((entry) => entry.messageId === turn.parent) : undefined
    turns.push({
      id: turn.messageId.slice(WORKBOT_MESSAGE_PREFIX.length),
      text: turn.kind === "report" || greeting ? "" : user.text,
      sentAt: turn.createdAt ?? null,
      finishedAt: working ? null : turn.updatedAt ?? null,
      status,
      attachments: turn.kind === "report" ? [] : (user.attachments ?? []),
      outputs: task
        ? [...new Map([...outputsOf(files, task.createdAt ?? null, task.updatedAt ?? null), ...outputs].map((file) => [file.id, file])).values()]
        : outputs,
      reaction,
      parts,
      modelSteps,
      error: status === "failed" ? friendlyError(turn.error) : null,
      tasks: turn.kind === undefined ? tasksOf(snapshot, turn.messageId, byTurn) : [],
      greeting,
      suggestions,
    })
  }
  return turns
}

/**
 * Turns the next read resumes with a fresh token: the newest message if the runner restarted mid-way, and any
 * background task or report that was paused (a restart, or a long task's token running out).
 */
export function interruptedTurnIds(snapshot: RunnerSnapshot): string[] {
  const ours = snapshot.turns.filter((entry) => entry.messageId.startsWith(WORKBOT_MESSAGE_PREFIX))
  const newest = ours.filter((entry) => entry.kind === undefined).at(-1)
  const background = ours.filter((entry) => entry.kind !== undefined && entry.status === "interrupted").map((entry) => entry.messageId)
  return newest?.status === "interrupted" ? [newest.messageId, ...background] : background
}

/** Whether Workbot is answering; background tasks working alongside don't hold up the conversation. */
export function threadBusy(snapshot: RunnerSnapshot) {
  if (snapshot.status === "busy") return true
  return snapshot.turns.some((turn) => turn.kind !== "task" && (ACTIVE.has(turn.status) || turn.status === "interrupted"))
}
