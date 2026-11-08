import { readBrowserTeachingPrompt, readBrowserSkillRunPrompt } from "@openwork/types/browser-demonstration"
import type { RunnerMessage, RunnerSnapshot, RunnerTurn } from "@openwork-ee/headless-protocol"
import { readWorkbotContextPrompt, workbotDocumentNavigationSchema, type WorkbotViewContext } from "@openwork/types/workbot-context"

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
  // Only a real list ("Next: a | b"), never a sentence that happens to start with "Next".
  const match = /^\**next\**\s*:\**\s*(.+\|.+)$/i.exec(last)
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
  /**
   * A safe plain-language failure, never a tool's raw output. Additive on purpose: already-open clients validate
   * status as running|done, so done means the call ended, not that it succeeded. New browser task cards read reason.
   */
  reason?: string
  /** The connected app it used, when known (for its logo). */
  app: string | null
  startedAt: number | null
  finishedAt: number | null
  /** What it did, in its own plain words: the updates it gave while working on its computer. */
  updates: string[]
  /** Work in the computer's browser rather than its other apps; absent for the rest. */
  surface?: "browser"
  /**
   * Commands and file reads on its computer (bash, look), with no screen to watch: running Blender from the command
   * line needs no live view. Absent while it works on the screen (the desktop tool) and from older servers.
   */
  background?: true
  /** Whether Workbot put this screen work in front of the person (the desktop tool's `show`): the last value it gave. */
  shown?: boolean
  /** The web pages it opened in the browser, oldest first, so the person can open them too. */
  pages?: WorkbotPage[]
  /**
   * Work in a connected app: which of its tools ran, in plain words ("Web search"), for the footnote under the answer
   * that lists what was used. Never a capability or connection id. Absent for computer work and from older servers.
   */
  detail?: string
  /** The connected app's website ("exa.ai"), for its logo when the name alone doesn't find one. */
  site?: string
  /** Work on one of the person's other computers (a remote task), not in an app. */
  remote?: true
  /**
   * Work in OpenWork itself rather than another connector: remote tasks, workflows, skills, Automations, Apps, admin
   * tools, background tasks. The page shows one OpenWork logo for all of it. Absent from older servers.
   */
  openwork?: true
}
/** A web page Workbot opened in its browser. `id` is short and stable, for the page's own link (/browser/<id>). */
export type WorkbotPage = { id: string; url: string; title: string }
/**
 * What Workbot said and did, in order. A text part is one model call's words, `step` being that call (counted from 0
 * within the turn): the page keeps one bubble per call, from its first streamed word to its stored copy.
 */
export type WorkbotPart = { kind: "text"; text: string; step: number } | { kind: "steps"; steps: WorkbotStep[] }

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
  /**
   * Its steps so far in plain words, oldest first (the newest 12): work in connected apps ("Searching Slack") and on
   * its computer, each done once its call has returned. For the task sheet; never a tool's output.
   */
  steps: WorkbotTaskStep[]
  /** Calls it has finished. */
  stepsDone: number
  /** The latest thing it wrote, on one line, while it works. */
  note: string | null
}

export type WorkbotTaskStep = { label: string; done: boolean; at: number | null }

/** How many of a task's steps the page gets: enough for the sheet, never a whole transcript. */
const TASK_STEPS = 12

/** A task's steps and progress from its own transcript: what it did in apps and on its computer, in plain words. */
function taskSteps(messages: RunnerMessage[], connectors: WorkbotConnectors) {
  const finished = new Set(messages.flatMap((message) => (message.role === "tool" ? [message.callId] : [])))
  const steps: WorkbotTaskStep[] = []
  let stepsDone = 0
  let note: string | null = null
  for (const message of messages) {
    if (message.role !== "assistant") continue
    const text = message.text.replace(/\s+/g, " ").trim()
    if (text) note = text.length > 160 ? `${text.slice(0, 159)}…` : text
    for (const call of message.toolCalls) {
      const done = finished.has(call.id)
      if (done) stepsDone += 1
      const app = connectorStep(call.name, call.input, connectors)
      const said = typeof call.input.description === "string" && call.input.description.trim() ? call.input.description.trim() : null
      const label = app ? app.label
        : COMPUTER_TOOLS.has(call.name) ? (said ?? (call.name === "desktop" ? desktopUpdate(call.input) : null) ?? "Working on my computer")
        : null
      if (!label) continue
      const short = label.slice(0, 80)
      const previous = steps.at(-1)
      // The same thing again (a retry, the next page of a search) is one step.
      if (previous?.label === short) { previous.done = done; continue }
      steps.push({ label: short, done, at: message.createdAt ?? null })
    }
  }
  return { steps: steps.slice(-TASK_STEPS), stepsDone, note }
}

export type WorkbotTurn = {
  id: string
  text: string
  context?: WorkbotViewContext
  /** Accepted requests to open a document beside the chat. Only requests: whether one opened is the page's to say. */
  navigation?: Array<{ id: string; fileId: string }>
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
  /** A closed recovery vocabulary; no provider text, account identifiers or credentials. */
  modelIssue?: "free_limit" | "usage_limit" | "payment_required"
  /** A failed turn that can work if sent again: the page offers "Try again", which answers it again in place. */
  retryable: boolean
  /** Background tasks this message started, oldest first. */
  tasks: WorkbotTask[]
  /** Workbot's first hello: it spoke first, so there is no message from the person above it. */
  greeting: boolean
  /** Things the person could ask next, offered as buttons under Workbot's hello. */
  suggestions: string[]
}

const ACTIVE = new Set(["queued", "running"])

/** Older runner lifecycle markers can survive beside a nonterminal status. Never advertise abandoned work as live. */
const ABANDONED = new Set(["runner_restart", "abandoned", "turn_abandoned", "runner_abandoned"])
const STOPPED = new Set(["aborted", "stopped", "cancelled", "canceled", "abandoned"])

function abandoned(turn: RunnerTurn) {
  return STOPPED.has(turn.status) || (turn.error !== null && ABANDONED.has(turn.error))
}

function taskStatus(turn: RunnerTurn): WorkbotTask["status"] {
  if (turn.status === "completed") return "done"
  if (turn.status === "failed") return "failed"
  if (abandoned(turn)) return "stopped"
  if (turn.status === "queued") return "queued"
  if (turn.status === "running") return "working"
  if (turn.status === "interrupted") return "paused"
  // The protocol is intentionally open to new statuses. An unknown status is not proof of a running job.
  return "failed"
}

function tasksOf(snapshot: RunnerSnapshot, parent: string, byTurn: Map<string, RunnerMessage[]>, connectors: WorkbotConnectors): WorkbotTask[] {
  return snapshot.turns
    .filter((entry) => entry.kind === "task" && entry.parent === parent)
    .map((entry) => {
      const status = taskStatus(entry)
      const open = status === "queued" || status === "working" || status === "paused"
      // Its plain-language updates: the description it gave each command on its computer.
      const updates = (byTurn.get(entry.messageId) ?? [])
        .flatMap((message) => (message.role === "assistant" ? message.toolCalls : []))
        .flatMap((call) => {
          if (!COMPUTER_TOOLS.has(call.name)) return []
          const said = typeof call.input.description === "string" && call.input.description.trim() ? call.input.description.trim() : call.name === "desktop" ? desktopUpdate(call.input) : null
          return said ? [said.slice(0, 80)] : []
        })
        .filter((update, index, all) => update !== all[index - 1])
      const update = open ? (updates.at(-1) ?? null) : null
      const progress = taskSteps(byTurn.get(entry.messageId) ?? [], connectors)
      return {
        id: entry.messageId.slice(WORKBOT_MESSAGE_PREFIX.length),
        title: entry.title ?? "Background task",
        status,
        startedAt: entry.createdAt ?? null,
        finishedAt: open ? null : (entry.updatedAt ?? null),
        update,
        updates,
        steps: progress.steps,
        stepsDone: progress.stepsDone,
        note: open ? progress.note : null,
      }
    })
}

/** The model refused the request as it was: sending it again gets the same answer. */
const REFUSED = /^model_(http_(400|413|422)|stream_invalid_request_error)$/
/** Workbot's model access is broken (key, permission, model): only an admin can fix it. */
const MISCONFIGURED = /^model_(credentials_missing|http_(401|402|403|404)|stream_(authentication_error|permission_error|not_found_error))$/

/**
 * Whether trying the same message again can work, so the page offers "Try again" only then: not when the model
 * refused it as it was, its setup is broken, or the message asked for more than one turn can do.
 */
export function retryableError(code: string | null): boolean {
  if (!code) return true
  return !REFUSED.test(code) && !MISCONFIGURED.test(code) && !modelIssue(code) && code !== "max_steps_exceeded" && code !== "stuck_repeating" && code !== "output_limit"
}

function modelIssue(code: string | null): WorkbotTurn["modelIssue"] {
  if (code === "model_free_allowance_exhausted") return "free_limit"
  if (code === "model_usage_limit_exceeded") return "usage_limit"
  if (code === "model_payment_required") return "payment_required"
  return undefined
}

/**
 * One short line for a failed turn that says what to do next. When trying again can work the page puts "Try again"
 * beside it, so the line doesn't say so again.
 */
function friendlyError(code: string | null): string {
  if (!code) return "Something went wrong on my side."
  if (REFUSED.test(code)) return "I couldn't take that request as it is. Try asking it a different way."
  if (MISCONFIGURED.test(code)) return "I can't reach the AI model. An admin needs to check how Workbot is set up."
  if (code.startsWith("model_")) return "I couldn't reach the AI model just now."
  if (code === "mcp_unavailable") return "I couldn't reach your connected apps just now."
  if (code === "turn_timeout") return "That took too long, so I stopped."
  if (code === "max_steps_exceeded") return "That needed more steps than I can take at once. Try a smaller piece of it."
  if (code === "stuck_repeating") return "I kept getting the same result, so I stopped. Try asking a different way."
  if (code === "output_limit") return "My answer kept getting too long to finish. Try a smaller piece of it."
  return "Something went wrong on my side."
}

// Microsoft 365 comes first: its capabilities are named like Google's ("…Microsoft365CalendarEvent…"), and the
// person should see the app they actually use, never "Google Calendar" for their Outlook calendar.
const APPS: Array<[RegExp, string]> = [
  [/slack/i, "Slack"],
  [/teams/i, "Microsoft Teams"],
  [/(outlook|microsoft|office365).*calendar|outlook.*event/i, "Outlook Calendar"],
  [/(microsoft|office365).*(mail|message|draft)|outlook/i, "Outlook"],
  [/(microsoft|office365).*(drive|file|folder|document|upload)|onedrive|sharepoint/i, "OneDrive"],
  [/microsoft|office365/i, "Microsoft 365"],
  [/gmail|mail/i, "Gmail"],
  [/calendar|gcal/i, "Google Calendar"],
  [/drive|docs|sheets/i, "Google Drive"],
  [/google.*(document|spreadsheet|sheet|slide|file|folder)/i, "Google Drive"],
  [/google.*chat/i, "Google Chat"],
  [/notion/i, "Notion"],
  [/linear/i, "Linear"],
  [/github/i, "GitHub"],
  [/hubspot/i, "HubSpot"],
  [/salesforce/i, "Salesforce"],
  [/jira|confluence|atlassian/i, "Atlassian"],
  // Den's built-in Google tools ("native:google-workspace:…") that no pattern above names more precisely.
  [/google/i, "Google Workspace"],
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
  const segment = capability.split(/[:/]/).pop() ?? ""
  const action = segment.toLowerCase()
  // Den's capabilities are camelCase operations whose first word is the verb ("updateMicrosoft365CalendarEvent",
  // "postCapabilitiesMicrosoft365CalendarEvents"); the rest of the name must not decide it ("…Messages" is a read).
  const verb = segment.match(/^[a-z]+(?=[A-Z0-9])/)?.[0]
  const plain = verb === "post" ? "create" : verb === "put" ? "update" : verb
  if (/draft/.test(action) && plain !== "send") return `Drafting in ${app}`
  const byVerb = plain ? APP_ACTIONS.find(([pattern]) => pattern.test(plain)) : undefined
  return (byVerb ?? APP_ACTIONS.find(([pattern]) => pattern.test(action)))?.[1](app) ?? `Looking in ${app}`
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The emoji of a `react` call, if it is exactly one (the runner checks too; the page never shows anything else). */
function reactionOf(input: Record<string, unknown>): string | null {
  const emoji = typeof input.emoji === "string" ? input.emoji.trim() : ""
  if (!emoji || emoji.length > 32 || [...graphemes.segment(emoji)].length !== 1) return null
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(emoji) ? emoji : null
}

/**
 * The person's connected apps by connection id, as their admins named them, with each one's website for its logo.
 * Read from Den by the host; without it (an older Den, or Den slow to answer) a well-known app is still named from
 * its tools, and any other is "a connected app". Connection and capability ids never reach the page.
 */
export type WorkbotConnectors = ReadonlyMap<string, { name: string; site: string | null }>

/** Connectors whose tools say which app they are ("web_search_exa"), by a word in the tool's name. */
const KNOWN_CONNECTORS: Record<string, { name: string; site: string }> = {
  exa: { name: "Exa", site: "exa.ai" },
  planetscale: { name: "PlanetScale", site: "planetscale.com" },
  pscale: { name: "PlanetScale", site: "planetscale.com" },
  sentry: { name: "Sentry", site: "sentry.io" },
  stripe: { name: "Stripe", site: "stripe.com" },
  figma: { name: "Figma", site: "figma.com" },
  granola: { name: "Granola", site: "granola.ai" },
  asana: { name: "Asana", site: "asana.com" },
  zendesk: { name: "Zendesk", site: "zendesk.com" },
  posthog: { name: "PostHog", site: "posthog.com" },
  vercel: { name: "Vercel", site: "vercel.com" },
  render: { name: "Render", site: "render.com" },
  intercom: { name: "Intercom", site: "intercom.com" },
  airtable: { name: "Airtable", site: "airtable.com" },
  supabase: { name: "Supabase", site: "supabase.com" },
  cloudflare: { name: "Cloudflare", site: "cloudflare.com" },
  deepwiki: { name: "DeepWiki", site: "deepwiki.com" },
}

/** "web_search_exa", "searchMessages" → ["web", "search", "exa"], ["search", "messages"]. */
function words(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/).map((word) => word.toLowerCase()).filter(Boolean)
}

/** What a tool does, in plain words, without the app's brand: "web_search_exa" in Exa (or "Exa Search") → "Web search". */
function toolDetail(tool: string, app: string | null) {
  const brand = app ? words(app)[0] : undefined
  const plain = words(tool).filter((word) => word !== brand && !KNOWN_CONNECTORS[word] && !/^(mcp|tool|v\d+)$/.test(word)).join(" ")
  if (!plain) return null
  const text = `${plain[0]!.toUpperCase()}${plain.slice(1)}`
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

/** A site taken from what the host gives: a bare host name only ("exa.ai"), never a path or query. */
function plainSite(site: string | null | undefined) {
  return site && /^[a-z0-9.-]{3,80}$/i.test(site) ? site.toLowerCase() : undefined
}

const REMOTE_ACTIONS: Record<string, string> = {
  create: "Starting a remote task",
  send: "Messaging the remote task",
  read: "Checking the remote task",
  status: "Checking the remote task",
  stop: "Stopping the remote task",
  answer: "Answering the remote task",
  targets: "Checking your computers",
  list: "Checking remote tasks",
}

export type ConnectorStep = { app: string | null; label: string; detail: string | null; site?: string; remote?: true; openwork?: true }

/** OpenWork's own features share one name and logo, so an answer shows a single OpenWork mark however many ran. */
const OPENWORK = { app: "OpenWork", site: "openworklabs.com", openwork: true } as const

const openworkStep = (label: string, detail: string | null, extra: { remote?: true } = {}): ConnectorStep => ({ ...OPENWORK, label, detail, ...extra })

/** A person-readable name from a slug ("plan-my-day" → "Plan my day"); null for anything that looks like an id. */
function plainName(value: unknown) {
  if (typeof value !== "string") return null
  const slug = value.trim().replace(/^skill:/, "")
  if (!/^[a-z0-9][a-z0-9 _-]{0,58}$/i.test(slug)) return null
  const parts = slug.split(/[-_ ]+/).filter(Boolean)
  // A trailing random suffix ("…-ksdx8c7f") is an id, not part of the name.
  if (parts.length > 1 && /^(?=.*\d)[a-z0-9]{6,}$/i.test(parts.at(-1) ?? "")) parts.pop()
  const text = parts.join(" ")
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : null
}

/** A short title the person gave (a background task's), on one line. */
function shortTitle(value: unknown) {
  if (typeof value !== "string") return null
  const text = value.replace(/\s+/g, " ").trim()
  if (!text) return null
  return text.length > 48 ? `${text.slice(0, 47)}…` : text
}

/** Workbot's direct tools from OpenWork: skills, Apps, Your agent's checks and its own background tasks. */
function openworkTool(name: string, input: Record<string, unknown>): ConnectorStep | null {
  switch (name) {
    case "start_task": return openworkStep("Starting a background task", shortTitle(input.title) ?? "Background task")
    case "stop_task": return openworkStep("Stopping a background task", "Background task")
    case "list_skills": return openworkStep("Checking skills", "Skills")
    case "get_skill": return openworkStep("Reading a skill", plainName(input.name) ?? "Skill")
    case "create_skill":
    case "update_skill": return openworkStep("Saving a skill", plainName(input.name) ?? "Skill")
    case "prepare_app":
    case "create_app": return openworkStep("Building an app", "App")
    case "update_app": return openworkStep("Updating an app", "App")
    case "read_app": return openworkStep("Opening an app", "App")
    case "render_workflow_artifact": return openworkStep("Showing a workflow's results", "Workflow")
    case "request_check": return openworkStep("Asking your agent to check", "Your agent")
    default: return null
  }
}

/** What an OpenWork capability does, by area: Den's own operations ("createCloudAutomation", "putMeAgent"). */
const OPENWORK_AREAS: Array<[RegExp, string]> = [
  [/automation/i, "Automations"],
  [/workflow/i, "Workflows"],
  [/skill/i, "Skills"],
  [/(^|[a-z])(app|apps|artifact)([A-Z]|$)/, "Apps"],
  [/agent/i, "Your agent"],
  [/member|organi[sz]ation|team|invit|role/i, "Organization"],
  [/connection|connector|mcp/i, "Connections"],
]

function openworkCapability(capability: string): ConnectorStep | null {
  if (capability.startsWith("remote-session:")) {
    const action = capability.slice("remote-session:".length)
    const label = REMOTE_ACTIONS[action] ?? "Checking the remote task"
    return openworkStep(label, "Remote task", { remote: true })
  }
  if (capability.startsWith("admin:")) return openworkStep("Using OpenWork admin tools", toolDetail(capability.slice("admin:".length), null) ?? "Admin tools")
  if (capability.startsWith("skill:")) return openworkStep("Using a skill", plainName(capability) ?? "Skill")
  // A plugin's skill or Workflow, by ids only: say what kind of thing ran, never which ids.
  if (capability.startsWith("plugin:")) return openworkStep("Using OpenWork", "Workflow or skill")
  // Den's own operations are bare camelCase names; anything with a prefix is some other source.
  if (!/^[a-z][a-zA-Z0-9]*$/.test(capability)) return null
  const area = OPENWORK_AREAS.find(([pattern]) => pattern.test(capability))?.[1] ?? "OpenWork"
  if (area === "Automations") {
    const verb = capability.match(/^[a-z]+/)?.[0] ?? ""
    const label = /create|post|put|update|patch|activate|deactivate/.test(verb) ? "Setting up an automation"
      : /run|trigger/.test(verb) ? "Running an automation"
      : /delete|archive|cancel/.test(verb) ? "Changing an automation"
      : "Checking automations"
    return openworkStep(label, area)
  }
  if (area === "Workflows") return openworkStep(/^(run|execute|post|trigger)/.test(capability) ? "Running a workflow" : "Checking workflows", area)
  return openworkStep(appActionLabel("OpenWork", capability), area)
}

/**
 * Work in a connected app, said the way a colleague would ("Searching Exa"), with which tool ran ("Web search") and
 * the app's website for its logo; or work in OpenWork itself (a remote task on another of the person's computers, a
 * workflow, skill, Automation, App, admin tool or background task), which the page shows as one OpenWork logo. Null
 * for everything else Workbot calls (finding tools, its own notes and files), which stays out of sight.
 */
export function connectorStep(name: string, input: Record<string, unknown>, connectors: WorkbotConnectors = new Map()): ConnectorStep | null {
  if (name !== "execute_capability") return openworkTool(name, input)
  if (typeof input.name !== "string") return null
  const capability = input.name.trim()
  // A connection's own tool: mcp:<connectionId>:<tool>. The id names the connection; the tool says what it did.
  const external = /^mcp:([^:]+):(.+)$/.exec(capability)
  if (external) {
    const [, connectionId = "", tool = ""] = external
    const known = connectors.get(connectionId)
    const guessed = words(tool).map((word) => KNOWN_CONNECTORS[word]).find(Boolean)
    const app = known?.name.trim() || guessed?.name || APPS.find(([pattern]) => pattern.test(tool))?.[1] || null
    const site = plainSite(known?.site ?? guessed?.site)
    return { app, label: app ? appActionLabel(app, tool) : "Using a connected app", detail: toolDetail(tool, app), ...(site ? { site } : {}) }
  }
  const own = /^(remote-session|admin|skill|plugin):/.test(capability) ? openworkCapability(capability) : null
  if (own) return own
  const app = APPS.find(([pattern]) => pattern.test(capability))?.[1] ?? null
  if (!app) return openworkCapability(capability)
  const tool = capability.split(/[:/]/).pop() ?? ""
  return { app, label: appActionLabel(app, capability), detail: toolDetail(tool, app) }
}

/** The conversation's kept files, so the ones Workbot made show under the answer that made them. */
export type FileNames = ReadonlyMap<string, { name: string; createdAt: number; updatedAt?: number; mediaType?: string; size?: number; source?: "user" | "agent" }>

const COMPUTER_TOOLS: ReadonlySet<string> = new Set(["bash", "look", "desktop"])

/** The page's address when it is an ordinary web page; anything else is never shown or linked. */
function webAddress(value: unknown): URL | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url : null
  } catch {
    return null
  }
}

/** A short, stable id for a page's address (FNV-1a), so its link survives reloads and new messages. */
export function workbotPageId(url: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < url.length; index++) hash = Math.imul(hash ^ url.charCodeAt(index), 0x01000193)
  return (hash >>> 0).toString(36)
}

function pageOf(url: URL): WorkbotPage {
  const host = url.hostname.replace(/^www\./, "")
  const path = url.pathname.replace(/\/+$/, "")
  const title = path ? `${host}${path.length > 40 ? `${path.slice(0, 39)}…` : path}` : host
  return { id: workbotPageId(url.href), url: url.href, title }
}

const BROWSER_ACTIONS: Array<[RegExp, string]> = [
  [/^(fill|select|set_checked)$/, "Filling in the form"],
  [/^click$/, "Clicking through the page"],
  [/^scroll$/, "Scrolling the page"],
  [/^key$/, "Typing on the page"],
]

/**
 * What a `desktop` call is doing, in plain words, when the model didn't say: never the values it typed, only where it
 * is and the kind of thing it is doing. Its own `description` comes first.
 */
function desktopUpdate(input: Record<string, unknown>): string | null {
  const args = typeof input.args === "object" && input.args !== null ? (input.args as Record<string, unknown>) : {}
  const operation = typeof input.operation === "string" ? input.operation : ""
  if (input.view === "browser") {
    const url = webAddress(args.url)
    if ((operation === "open" || operation === "navigate") && url) return `Opening ${pageOf(url).title}`
    if (operation === "observe") return "Looking at the page"
    if (operation === "extract") return "Reading the page"
    if (operation === "tabs") return "Checking open tabs"
    if (operation === "act" && Array.isArray(args.actions)) {
      const types = args.actions.map((action) => (typeof action === "object" && action !== null ? String((action as Record<string, unknown>).type ?? "") : ""))
      for (const [pattern, label] of BROWSER_ACTIONS) if (types.some((type) => pattern.test(type))) return label
    }
    return "Working in the browser"
  }
  const app = typeof args.app === "string" && /^[a-z][a-z0-9-]{0,30}$/i.test(args.app) ? args.app : null
  if (operation === "computer_launch") return app ? `Opening ${app[0]!.toUpperCase()}${app.slice(1)}` : "Opening an app"
  if (operation === "computer_app_script") return app ? `Working in ${app[0]!.toUpperCase()}${app.slice(1)}` : "Working in an app"
  if (operation === "computer_observe" || operation === "computer_zoom") return "Looking at the screen"
  if (operation === "computer_apps" || operation === "computer_discover") return "Checking what's installed"
  if (operation === "computer_act") return "Working in the app"
  return null
}

/**
 * Work on Workbot's computer reads as one step, however many commands it took: the person sees that it is using
 * its computer, never commands or raw failure details (DESIGN C3, T2). Failures retain a safe reason rather than
 * silently becoming successful when later calls are merged. Work in its browser is its own
 * step ("Using the browser"), with the pages it opened, and so is work on its screen apart from commands run in the
 * background ("Working on my computer"), which has nothing to watch. What it is doing, in its own words, travels in `updates`; the
 * page shows the newest one under the step.
 */
function addComputerStep(parts: WorkbotPart[], name: string, input: Record<string, unknown>, result: RunnerMessage | undefined, at: number | null) {
  const running = result === undefined
  const browser = name === "desktop" && input.view === "browser"
  const background = name !== "desktop"
  const described = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null
  const said = described ?? (name === "desktop" ? desktopUpdate(input) : null)
  const doing = said ? said.slice(0, 80) : null
  const last = parts.at(-1)
  const previous = last?.kind === "steps" ? last.steps.at(-1) : undefined
  const step: WorkbotStep =
    previous?.icon === "computer" && (previous.surface === "browser") === browser && (previous.background === true) === background
      ? previous
      : {
          label: browser ? "Using the browser" : background ? "Working on my computer" : "Using my computer",
          icon: "computer", status: "done", app: null, startedAt: at, finishedAt: null, updates: [],
          ...(browser ? { surface: "browser" as const } : {}),
          ...(background ? { background: true as const } : {}),
        }
  if (doing && step.updates.at(-1) !== doing) step.updates.push(doing)
  if (!background && typeof input.show === "boolean") step.shown = input.show
  const args = typeof input.args === "object" && input.args !== null ? (input.args as Record<string, unknown>) : {}
  const url = browser && (input.operation === "open" || input.operation === "navigate") ? webAddress(args.url) : null
  if (url) {
    const page = pageOf(url)
    const pages = (step.pages ??= [])
    if (!pages.some((entry) => entry.id === page.id) && pages.length < 12) pages.push(page)
  }
  // The time it actually worked: a command cut off by a restart or a sleeping laptop says nothing about the work.
  const before = workedMs.get(step) ?? 0
  const ended = result?.createdAt ?? null
  const took = at !== null && ended !== null ? Math.max(0, ended - at) : 0
  const worked = before + (took <= LONGEST_COMMAND_MS ? took : 0)
  workedMs.set(step, worked)
  const failed = result?.role === "tool" && result.isError
  if (failed) step.reason = browser ? "The browser action couldn't finish." : "The computer action couldn't finish."
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

function statusOf(turn: RunnerTurn, resumable: ReadonlySet<string>): WorkbotTurnStatus {
  if (turn.status === "completed") return "done"
  if (turn.status === "failed") return "failed"
  if (abandoned(turn)) return "stopped"
  if (turn.status === "queued") return "queued"
  if (turn.status === "running") return "working"
  // Only the newest foreground interruption is resumed. Older interrupted messages aren't still working.
  if (turn.status === "interrupted") return resumable.has(turn.messageId) ? "working" : "stopped"
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

export function buildWorkbotTurns(snapshot: RunnerSnapshot, files: FileNames = new Map(), connectors: WorkbotConnectors = new Map()): WorkbotTurn[] {
  const byTurn = new Map<string, RunnerMessage[]>()
  for (const message of snapshot.messages) {
    if (!message.messageId) continue
    const list = byTurn.get(message.messageId) ?? []
    list.push(message)
    byTurn.set(message.messageId, list)
  }

  const resumable = new Set(interruptedTurnIds(snapshot))
  const turns: WorkbotTurn[] = []
  for (const turn of snapshot.turns) {
    // A background task's own work stays out of the conversation; its report shows instead.
    if (!turn.messageId.startsWith(WORKBOT_MESSAGE_PREFIX) || turn.kind === "task") continue
    const messages = byTurn.get(turn.messageId) ?? []
    // A message joins the transcript only when its turn starts; until then (waiting behind the answer in progress, or
    // stopped before it started) the runner sends what it was sent with, so it stays in the conversation through a
    // reload, a chat switch or Stop.
    const stored = messages.find((message) => message.role === "user")
    const waiting = turn.kind === undefined && !isGreetingRunnerId(turn.messageId) && turn.prompt !== undefined ? { role: "user" as const, text: turn.prompt, attachments: undefined } : null
    const user = stored?.role === "user" ? stored : waiting
    if (!user) continue
    const results = new Map(messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message] as const] : [])))

    const parts: WorkbotPart[] = []
    const navigation: Array<{ id: string; fileId: string }> = []
    let reaction: string | null = null
    let modelSteps = 0
    const greeting = isGreetingRunnerId(turn.messageId)
    for (const message of messages) {
      if (message.role !== "assistant") continue
      modelSteps += 1
      const text = message.text.trim()
      // Each model call's words are their own bubble, the same one the page streamed, so two never become one once
      // stored. The greeting follows the same streaming contract as other replies.
      if (text) parts.push({ kind: "text", text, step: modelSteps - 1 })
      for (const call of message.toolCalls) {
        if (call.name === "open_document") {
          const target = workbotDocumentNavigationSchema.safeParse(call.input)
          const result = results.get(call.id)
          if (turn.kind === undefined && !greeting && target.success && result?.role === "tool" && !result.isError) navigation.push({ id: call.id, fileId: target.data.fileId })
          continue
        }
        if (call.name === "react") {
          const result = results.get(call.id)
          const emoji = reactionOf(call.input)
          if (emoji && !(result?.role === "tool" && result.isError)) reaction = emoji
          continue
        }
        if (COMPUTER_TOOLS.has(call.name)) {
          addComputerStep(parts, call.name, call.input, results.get(call.id), message.createdAt ?? null)
          continue
        }
        // Only work in a connected app or in OpenWork itself is worth a logo under the answer ("Searching Exa");
        // lookups, notes to self and files stay out of sight: files it made show as cards under the answer.
        const used = connectorStep(call.name, call.input, connectors)
        if (!used) continue
        const result = results.get(call.id)
        const step: WorkbotStep = {
          label: used.label,
          icon: "app",
          status: result === undefined ? "running" : "done",
          app: used.app,
          startedAt: message.createdAt ?? null,
          finishedAt: result?.createdAt ?? null,
          updates: [],
          ...(used.detail ? { detail: used.detail } : {}),
          ...(used.site ? { site: used.site } : {}),
          ...(used.remote ? { remote: true as const } : {}),
          ...(used.openwork ? { openwork: true as const } : {}),
        }
        const last = parts.at(-1)
        if (last?.kind === "steps") last.steps.push(step)
        else parts.push({ kind: "steps", steps: [step] })
      }
    }

    const status = statusOf(turn, resumable)
    const working = status === "working" || status === "queued"
    // A cut-off call has no tool result, but a stopped/failed turn cannot have a running step or elapsed timer.
    if (!working) {
      for (const part of parts) {
        if (part.kind !== "steps") continue
        for (const step of part.steps) {
          if (step.status !== "running") continue
          step.status = "done"
          step.reason ??= status === "stopped" ? "Stopped before the action finished." : "The action ended without a result."
          step.finishedAt = turn.updatedAt ?? step.startedAt
        }
      }
    }
    // A closing "Next: a | b | c" line becomes buttons: the hello asks for one, and later answers sometimes follow suit.
    let suggestions: string[] = []
    if (!working) {
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
    const visible = readWorkbotContextPrompt(readBrowserSkillRunPrompt(readBrowserTeachingPrompt(user.text)))
    turns.push({
      id: turn.messageId.slice(WORKBOT_MESSAGE_PREFIX.length),
      text: turn.kind === "report" || greeting ? "" : visible.text,
      ...(!greeting && turn.kind !== "report" && visible.context ? { context: visible.context } : {}),
      sentAt: turn.createdAt ?? null,
      finishedAt: working ? null : turn.updatedAt ?? null,
      status,
      attachments: turn.kind === "report" ? [] : (user.attachments ?? []),
      outputs: task
        ? [...new Map([...outputsOf(files, task.createdAt ?? null, task.updatedAt ?? null), ...outputs].map((file) => [file.id, file])).values()]
        : outputs,
      reaction,
      ...(navigation.length ? { navigation } : {}),
      parts,
      modelSteps,
      error: status === "failed" ? friendlyError(turn.error) : null,
      ...(status === "failed" && modelIssue(turn.error) ? { modelIssue: modelIssue(turn.error) } : {}),
      retryable: status === "failed" && retryableError(turn.error),
      tasks: turn.kind === undefined ? tasksOf(snapshot, turn.messageId, byTurn, connectors) : [],
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
  const canResume = (entry: RunnerTurn) => entry.status === "interrupted" && !abandoned(entry)
  const background = ours.filter((entry) => entry.kind !== undefined && canResume(entry)).map((entry) => entry.messageId)
  return newest && canResume(newest) ? [newest.messageId, ...background] : background
}

/** Whether Workbot is answering; background tasks working alongside don't hold up the conversation. */
export function threadBusy(snapshot: RunnerSnapshot) {
  // A session's aggregate flag may lag its turns after Stop or a restart. Explicit lifecycle state wins.
  if (snapshot.turns.length === 0) return snapshot.status === "busy"
  const resumable = new Set(interruptedTurnIds(snapshot))
  return snapshot.turns.some((turn) => turn.kind !== "task" && !abandoned(turn) && (ACTIVE.has(turn.status) || resumable.has(turn.messageId)))
}
