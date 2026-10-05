import type { RunnerMessage, RunnerSnapshot, RunnerTurn } from "@openwork-ee/headless-protocol"

/**
 * Workbot is one conversation per person. The runner keeps the transcript;
 * this module turns it into what the person sees: their message, then the
 * answer as it happened (text, and quiet step lines between), in order.
 * Tool names, models and raw errors never reach the page.
 */

/** Runner message ids for Workbot turns are the page's own ids with this prefix. */
export const WORKBOT_MESSAGE_PREFIX = "wb_"

export type WorkbotTurnStatus = "queued" | "working" | "done" | "failed" | "stopped"
/** A file in the conversation; `updatedAt` changes when Workbot revises it in place. */
export type WorkbotAttachment = { id: string; name: string; mediaType: string; size: number; updatedAt?: number }
export type WorkbotStep = {
  label: string
  /** What the leading slot shows: a connected app's logo, a file, or Workbot's computer. */
  icon: "app" | "file" | "dot" | "computer"
  status: "running" | "done" | "error"
  /** The connected app it used, when known (for its logo). */
  app: string | null
  startedAt: number | null
  finishedAt: number | null
  /** What it did, in its own plain words: the updates it gave while working on its computer. */
  updates: string[]
}
export type WorkbotPart = { kind: "text"; text: string } | { kind: "steps"; steps: WorkbotStep[] }

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
  /** Text and steps in the order they happened. */
  parts: WorkbotPart[]
  /**
   * How many model calls are stored. Live text streamed for call N belongs after these parts while
   * N >= modelSteps; once stored, it is part of `parts`.
   */
  modelSteps: number
  error: string | null
}

const ACTIVE = new Set(["queued", "running"])

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
  [/calendar/i, "Google Calendar"],
  [/drive|docs|sheets/i, "Google Drive"],
  [/notion/i, "Notion"],
  [/linear/i, "Linear"],
  [/github/i, "GitHub"],
  [/outlook|microsoft|teams|onedrive|sharepoint/i, "Microsoft 365"],
  [/hubspot/i, "HubSpot"],
  [/salesforce/i, "Salesforce"],
  [/jira|confluence|atlassian/i, "Atlassian"],
]

/** What it did in a connected app, in the person's words: "Searching Slack", then "Searched Slack" (DESIGN C4). */
const APP_ACTIONS: Array<[RegExp, (app: string) => [string, string]]> = [
  [/search|find|query|lookup/, (app) => [`Searching ${app}`, `Searched ${app}`]],
  [/draft/, (app) => [`Drafting in ${app}`, `Drafted in ${app}`]],
  [/send|post|reply|chat_?message|message/, (app) => [`Sending with ${app}`, `Sent with ${app}`]],
  [/create|add|insert|schedule/, (app) => [`Adding to ${app}`, `Added to ${app}`]],
  [/update|edit|patch|move|rename/, (app) => [`Updating ${app}`, `Updated ${app}`]],
  [/delete|remove|archive|trash/, (app) => [`Removing from ${app}`, `Removed from ${app}`]],
  [/list|get|read|fetch|retrieve|view|show|events|history/, (app) => [`Checking ${app}`, `Checked ${app}`]],
]

function appActionLabel(app: string, capability: string, running: boolean) {
  const action = capability.split(/[:/]/).pop()?.toLowerCase() ?? ""
  const [present, past] = APP_ACTIONS.find(([pattern]) => pattern.test(action))?.[1](app) ?? [`Using ${app}`, `Used ${app}`]
  return running ? present : past
}

function appOf(name: string, input: Record<string, unknown>): string | null {
  const target = name === "execute_capability" && typeof input.name === "string" ? input.name : name
  return APPS.find(([pattern]) => pattern.test(target))?.[1] ?? null
}

/** A kept file's name and when it was saved, to label steps that open it. */
export type FileNames = ReadonlyMap<string, { name: string; createdAt: number; updatedAt?: number; mediaType?: string; size?: number; source?: "user" | "agent" }>

function dayWord(at: number, now: number) {
  const days = Math.floor((new Date(now).setHours(0, 0, 0, 0) - new Date(at).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 7) return new Date(at).toLocaleDateString("en-US", { weekday: "long" })
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/**
 * What a person sees of a step, in a coworker's terms, or null to leave it out. A step shows only when it maps to
 * something they know: an app they connected (labelled from its logo elsewhere), their files, setting up a
 * schedule, or a note for later. Lookups, internal names and housekeeping never show (DESIGN C3, T2).
 */
function workbotStepLabel(name: string, input: Record<string, unknown>, files: FileNames, at: number): string | null {
  const path = typeof input.path === "string" ? input.path : null
  if (name === "open_file") {
    const file = typeof input.id === "string" ? files.get(input.id) : undefined
    if (!file) return "Opened a file"
    const day = dayWord(file.createdAt, at)
    return day === "today" ? `Opened ${file.name}` : `Opened ${file.name} from ${day}`
  }
  if (name === "save_file") {
    const named = typeof input.name === "string" && input.name.trim() ? input.name.trim() : path?.split("/").pop()
    return named ? `Saved ${named} to your files` : "Saved a file to your files"
  }
  if (path?.startsWith("memory/") && (name === "write_file" || name === "edit_file")) return "Made a note for later"
  if (name === "execute_capability" && typeof input.name === "string" && /createCloudAutomation$/i.test(input.name)) return "Setting up the schedule"
  return null
}

const COMPUTER_TOOLS: ReadonlySet<string> = new Set(["bash", "look"])

/**
 * Work on Workbot's computer reads as one quiet step, however many commands it took: the person sees that it
 * used its computer and for how long, never commands, retries or failures it recovered from (DESIGN C3, T2).
 * What it is doing, in its own words, travels in `updates`; the page shows the newest one under the step.
 */
function addComputerStep(parts: WorkbotPart[], input: Record<string, unknown>, result: RunnerMessage | undefined, at: number | null) {
  const running = result === undefined
  const doing = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 80) : null
  const last = parts.at(-1)
  const previous = last?.kind === "steps" ? last.steps.at(-1) : undefined
  const step: WorkbotStep =
    previous?.icon === "computer" ? previous : { label: "", icon: "computer", status: "done", app: null, startedAt: at, finishedAt: null, updates: [] }
  if (doing && step.updates.at(-1) !== doing) step.updates.push(doing)
  // The time it actually worked: a command cut off by a restart or a sleeping laptop says nothing about the work.
  const before = workedMs.get(step) ?? 0
  const ended = result?.createdAt ?? null
  const took = at !== null && ended !== null ? Math.max(0, ended - at) : 0
  const worked = before + (took <= LONGEST_COMMAND_MS ? took : 0)
  workedMs.set(step, worked)
  step.status = running ? "running" : "done"
  step.label = running ? "Using my computer" : "Used my computer"
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
    if (!turn.messageId.startsWith(WORKBOT_MESSAGE_PREFIX)) continue
    const messages = byTurn.get(turn.messageId) ?? []
    const user = messages.find((message) => message.role === "user")
    // Queued follow-ups join the transcript only when they start; the page shows its own copy until then.
    if (!user || user.role !== "user") continue
    const results = new Map(messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message] as const] : [])))

    const parts: WorkbotPart[] = []
    let modelSteps = 0
    for (const message of messages) {
      if (message.role !== "assistant") continue
      modelSteps += 1
      const text = message.text.trim()
      if (text) {
        const last = parts.at(-1)
        if (last?.kind === "text") last.text = `${last.text}\n\n${text}`
        else parts.push({ kind: "text", text })
      }
      for (const call of message.toolCalls) {
        if (COMPUTER_TOOLS.has(call.name)) {
          addComputerStep(parts, call.input, results.get(call.id), message.createdAt ?? null)
          continue
        }
        const result = results.get(call.id)
        const app = call.name === "execute_capability" ? appOf(call.name, call.input) : null
        const status = result === undefined ? "running" : result.role === "tool" && result.isError ? "error" : "done"
        // Work in a connected app reads as that app ("Searched Slack"); anything else only if a person knows it.
        const label = app ? appActionLabel(app, String(call.input.name ?? ""), status === "running") : workbotStepLabel(call.name, call.input, files, message.createdAt ?? Date.now())
        if (!label) continue
        const step: WorkbotStep = {
          label,
          icon: app ? "app" : call.name === "open_file" || call.name === "save_file" ? "file" : "dot",
          status,
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
    turns.push({
      id: turn.messageId.slice(WORKBOT_MESSAGE_PREFIX.length),
      text: user.text,
      sentAt: turn.createdAt ?? null,
      finishedAt: working ? null : turn.updatedAt ?? null,
      status,
      attachments: user.attachments ?? [],
      outputs: outputsOf(files, turn.createdAt ?? null, working ? null : (turn.updatedAt ?? null)),
      parts,
      modelSteps,
      error: status === "failed" ? friendlyError(turn.error) : null,
    })
  }
  return turns
}

/** The newest turn the runner restarted mid-way, which the next read resumes. */
export function interruptedTurnId(snapshot: RunnerSnapshot): string | null {
  const turn = snapshot.turns.filter((entry) => entry.messageId.startsWith(WORKBOT_MESSAGE_PREFIX)).at(-1)
  return turn?.status === "interrupted" ? turn.messageId : null
}

export function threadBusy(snapshot: RunnerSnapshot) {
  if (snapshot.status === "busy") return true
  return snapshot.turns.some((turn) => ACTIVE.has(turn.status) || turn.status === "interrupted")
}
