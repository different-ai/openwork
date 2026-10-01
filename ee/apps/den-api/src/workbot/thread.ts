import type { RunnerMessage, RunnerSnapshot, RunnerTurn } from "../headless-runner/client.js"
import { stepLabel } from "../headless-runner/step-label.js"

/**
 * Workbot is one conversation per person. The runner keeps the transcript;
 * this module turns it into what the person sees: their message, a short
 * list of steps, the answer, and cards for drafts, schedules and the browser.
 * Tool names, models and raw errors never reach the page.
 */

/** Runner message ids for Workbot turns are the page's own ids with this prefix. */
export const WORKBOT_MESSAGE_PREFIX = "wb_"

export type WorkbotTurnStatus = "queued" | "working" | "done" | "failed" | "stopped"
export type WorkbotStep = { label: string; status: "running" | "done" | "error" }

export type WorkbotTurn = {
  id: string
  text: string
  sentAt: number | null
  finishedAt: number | null
  status: WorkbotTurnStatus
  /** The answer, Markdown. Empty while working. */
  reply: string
  /** What it is doing right now, while working. */
  activity: string | null
  steps: WorkbotStep[]
  /** Drafts it wrote in this turn. */
  files: string[]
  /** Automations it created in this turn. */
  automationIds: string[]
  /** `site` is the host the browser last opened, for the hand-off card. */
  browser: { used: boolean; handedOff: boolean; site: string | null }
  error: string | null
}

const ACTIVE = new Set(["queued", "running"])

function friendlyError(code: string | null): string {
  if (!code) return "Something went wrong. Try again."
  if (code.startsWith("model_")) return "I couldn't reach the AI model just now. Try again in a moment."
  if (code === "mcp_unavailable") return "I couldn't reach your connected apps just now. Try again in a moment."
  if (code === "turn_timeout") return "That took too long, so I stopped."
  if (code === "max_steps_exceeded") return "That needed more steps than I can take at once. Try a smaller piece of it."
  return "Something went wrong. Try again."
}

/** Drafts are named the way the person sees them on their card, never by path. */
function draftTitle(path: string) {
  const name = (path.split("/").pop() ?? path).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim()
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "a draft"
}

function workbotStepLabel(name: string, input: Record<string, unknown>) {
  if ((name === "write_file" || name === "edit_file") && typeof input.path === "string") return `Writing ${draftTitle(input.path)}`
  if (name === "read_file" && typeof input.path === "string") return `Reading ${draftTitle(input.path)}`
  if (name === "list_files") return "Checking my notes"
  return stepLabel(name, input)
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null
  } catch {
    return null
  }
}

function statusOf(turn: RunnerTurn): WorkbotTurnStatus {
  if (turn.status === "queued") return "queued"
  // An interrupted turn is resumed by the next read, so the person sees it still working.
  if (turn.status === "running" || turn.status === "interrupted") return "working"
  if (turn.status === "completed") return "done"
  if (turn.status === "aborted") return "stopped"
  return "failed"
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Finds the created Automation's id in a createCloudAutomation result, however it is wrapped. */
export function createdAutomationId(output: string | undefined): string | null {
  if (!output) return null
  const visit = (value: unknown, depth: number): string | null => {
    if (depth > 4 || typeof value !== "object" || value === null) return null
    if ("automation" in value && typeof value.automation === "object" && value.automation !== null
      && "id" in value.automation && typeof value.automation.id === "string") return value.automation.id
    for (const child of Object.values(value)) {
      const found = typeof child === "string" ? visit(parseJson(child), depth + 1) : visit(child, depth + 1)
      if (found) return found
    }
    return null
  }
  return visit(parseJson(output), 0) ?? /"automation"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/.exec(output)?.[1] ?? null
}

function isCreateAutomationCall(name: string, input: Record<string, unknown>) {
  return name === "execute_capability" && typeof input.name === "string" && /createCloudAutomation$/i.test(input.name)
}

export function buildWorkbotTurns(snapshot: RunnerSnapshot): WorkbotTurn[] {
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

    const steps: WorkbotStep[] = []
    const files: string[] = []
    const automationIds: string[] = []
    let browserUsed = false
    let lastBrowserCall: string | null = null
    let browserSite: string | null = null
    let reply = ""
    let activity: string | null = null
    for (const message of messages) {
      if (message.role !== "assistant") continue
      if (message.toolCalls.length === 0) {
        reply = message.text
        continue
      }
      if (message.text.trim()) activity = message.text.trim()
      for (const call of message.toolCalls) {
        const result = results.get(call.id)
        const status = result === undefined ? "running" : result.role === "tool" && result.isError ? "error" : "done"
        const label = workbotStepLabel(call.name, call.input)
        if (steps.at(-1)?.label !== label) steps.push({ label, status })
        else steps[steps.length - 1] = { label, status }
        if (status === "running") activity = label
        if ((call.name === "write_file" || call.name === "edit_file") && typeof call.input.path === "string" && status === "done" && !files.includes(call.input.path)) {
          files.push(call.input.path)
        }
        if (call.name.startsWith("browser_")) {
          browserUsed = true
          lastBrowserCall = call.name
          const site = typeof call.input.url === "string" ? hostOf(call.input.url) : typeof call.input.site === "string" ? call.input.site : null
          if (site) browserSite = site
        }
        if (isCreateAutomationCall(call.name, call.input) && result?.role === "tool" && !result.isError) {
          const id = createdAutomationId(result.output)
          if (id && !automationIds.includes(id)) automationIds.push(id)
        }
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
      reply: working ? "" : reply,
      activity: working ? activity : null,
      steps,
      files,
      automationIds,
      browser: { used: browserUsed, handedOff: lastBrowserCall === "browser_handoff", site: browserSite },
      error: status === "failed" ? friendlyError(turn.error) : null,
    })
  }
  return turns
}

/** The newest turn the runner restarted mid-way, which the next send resumes. */
export function interruptedTurnId(snapshot: RunnerSnapshot): string | null {
  const turn = snapshot.turns.filter((entry) => entry.messageId.startsWith(WORKBOT_MESSAGE_PREFIX)).at(-1)
  return turn?.status === "interrupted" ? turn.messageId : null
}

export function threadBusy(snapshot: RunnerSnapshot) {
  return snapshot.turns.some((turn) => ACTIVE.has(turn.status) || turn.status === "interrupted")
}
