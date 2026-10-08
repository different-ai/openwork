import type { WorkbotAttachment, WorkbotStep, WorkbotTask, WorkbotTurn } from "./contract"
import type { LiveText } from "./live"

/**
 * How Workbot's conversation is shown, the same on every client: what of a reply shows while it is written, when a
 * timestamp appears, what a file is called. Plain functions; each client draws them its own way.
 */

/** Both ways Workbot's hello can fail read the same: the drawn greeting stays, and this one line says what didn't. */
export const HELLO_FAILED = "I couldn't check your day just now."

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

export function timeLabel(at: number) {
  return new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

function startOfDay(at: number) {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** "Today", "Yesterday", "Friday", or "Sep 12" for older days. */
export function dayLabel(at: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return WEEKDAYS[new Date(at).getDay()] ?? "Earlier"
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** A conversation timestamp: "Today 9:41 AM", "Yesterday …", the weekday within a week, else the date. */
export function timestampLabel(at: number, now = Date.now()) {
  const date = new Date(at)
  const today = new Date(now)
  const yesterday = new Date(now - 86_400_000)
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
  if (date.toDateString() === today.toDateString()) return `Today ${time}`
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`
  if (now - at < 6 * 86_400_000) return `${date.toLocaleDateString("en-US", { weekday: "long" })} ${time}`
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`
}

/** A new timestamp shows when the day changes or after a quiet hour, like a messaging app. */
export function showsTimestamp(previousAt: number | null, at: number) {
  if (!at) return false
  if (!previousAt) return true
  return new Date(previousAt).toDateString() !== new Date(at).toDateString() || at - previousAt > 60 * 60_000
}

/** "Morning", "Hi" or "Evening", by the hour of `at`. */
export function greetingWord(at: number) {
  const hour = new Date(at).getHours()
  return hour < 12 ? "Morning" : hour < 18 ? "Hi" : "Evening"
}

export function initials(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return "?"
  const first = parts[0] ?? ""
  return (parts.length === 1 ? first.slice(0, 2) : `${first[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`).toUpperCase()
}

export function firstNameOf(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] || null
}

/** "now", "5m", "3h", "2d", or the date: how long ago a chat was last used, as a chat list shows it. */
export function sinceLabel(at: number, now: number = Date.now()) {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** A side chat's name in the list and its header: the name Workbot gave it, or "New side chat" until then. */
export function chatTitle(title: string | undefined) {
  return title?.trim() || "New side chat"
}

/** Lists with more side chats than this get a filter. */
export const CHAT_FILTER_FROM = 6

/** The welcome shows until the person is past it: nothing from them yet, and a hello they haven't been welcomed for. */
export function needsWelcome(turns: WorkbotTurn[], welcomedAt: string | null) {
  if (turns.some((turn) => !turn.greeting)) return false
  const hello = turns[0]
  if (!hello?.sentAt) return true
  return welcomedAt !== String(hello.sentAt)
}

/** The three starters on the first open, pointed at the apps the person has connected. */
export function firstOpenSuggestions(apps: string[]) {
  const has = (pattern: RegExp) => apps.find((app) => pattern.test(app)) ?? null
  const slack = has(/slack/i)
  return [
    { text: slack ? "Catch me up on Slack" : "Catch me up on what I missed", app: slack },
    { text: "Emails that need a reply", app: has(/gmail|mail|outlook/i) },
    { text: "Plan my day", app: has(/calendar/i) },
  ]
}

/** An answer as it is written, without a closing "Next:" line, which becomes buttons once the answer is done. */
export function withoutNextLine(text: string) {
  const lines = text.split("\n")
  const next = lines.findIndex((line) => /^\**next\**\s*:/i.test(line.trim()))
  if (next !== -1) return lines.slice(0, next).join("\n").trimEnd()
  // A last line that may still become "Next:" waits until it can't.
  const last = lines.at(-1)?.trim().replace(/\*/g, "").toLowerCase() ?? ""
  if (last && "next:".startsWith(last)) return lines.slice(0, -1).join("\n").trimEnd()
  return text
}

/**
 * The hello as it is written: nothing while it is still looking things up (a call that starts a lookup, or a short
 * line that could be a note to itself), and never its closing "Next:" line.
 */
export function helloSoFar(text: string, working: LiveText["working"] | null) {
  if (working || (text.length < 40 && !text.includes("\n"))) return ""
  return withoutNextLine(text)
}

/** What of a turn's reply shows right now: its streamed text, its computer starting, or a step still running. */
export function replyProgress(turn: WorkbotTurn, live: LiveText | null) {
  const working = turn.status === "working" || turn.status === "queued"
  // The model call in progress (not stored yet): its text so far, and whether it has started a step.
  const current = working && live && live.step >= turn.modelSteps ? live : null
  // Workbot's hello streams only its message, never its notes between lookups.
  const liveText = turn.greeting ? helloSoFar(current?.text ?? "", current?.working ?? null) : withoutNextLine(current?.text ?? "")
  const last = turn.parts.at(-1)
  // Its computer starting before the step is stored: the card shows right away, after what it just said.
  const startingCard = working && !turn.greeting && current?.working?.on === "computer" && !(last?.kind === "steps" && last.steps.some((step) => step.icon === "computer"))
  const lastIsLive = working && last?.kind === "steps" && !liveText && !startingCard
  return { working, liveText, startingCard, lastIsLive }
}

/** Workbot owes this reply and none of it shows yet (a hello's lookups stay hidden, so they don't count as showing). */
export function awaitingReply(turn: WorkbotTurn, live: LiveText | null) {
  if (turn.status !== "working") return false
  const { liveText, startingCard, lastIsLive } = replyProgress(turn, live)
  return !liveText && !startingCard && (Boolean(turn.greeting) || !lastIsLive)
}

/** An app the turn used, for the "Using …" line: Workbot's computer or a connected app. */
export type UsedApp = { key: string; name: string; computer: boolean }

export function usedApps(steps: WorkbotStep[], starting: LiveText["working"] | null): UsedApp[] {
  const used: UsedApp[] = []
  const add = (entry: UsedApp) => {
    if (!used.some((existing) => existing.key === entry.key)) used.push(entry)
  }
  for (const step of steps) {
    if (step.icon === "computer") add({ key: "computer", name: "my computer", computer: true })
    else if (step.app) add({ key: step.app, name: step.app, computer: false })
  }
  if (starting?.on === "computer") add({ key: "computer", name: "my computer", computer: true })
  return used
}

export function joinNames(names: string[]) {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
}

/** "12s", "3m 4s", "1h 5m". */
export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** A computer update stays at least this long, so quick commands read as one calm change. */
export const UPDATE_HOLD_MS = 1_600
/** The typing dots show only once a reply has been owed this long, so they don't flash between two steps. */
export const TYPING_SETTLE_MS = 350

export const isOpenTask = (task: WorkbotTask) => task.status === "queued" || task.status === "working" || task.status === "paused"

/** A background task card's line: what it is doing now, or how it ended. */
export function taskDetail(task: WorkbotTask) {
  if (isOpenTask(task)) return task.status === "queued" ? "Waiting to start" : task.status === "paused" ? "Picking it back up" : (task.update ?? "Working on it")
  return task.status === "done" ? "Done" : task.status === "failed" ? "Couldn't finish" : "Stopped"
}

/** What Workbot is asked when the person tries a failed background task again from its card. */
export const retryTaskMessage = (task: WorkbotTask) => `Try the "${task.title}" background task again.`

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
export const isImage = (mediaType: string) => IMAGE_TYPES.has(mediaType)

export function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export const extensionOf = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "")

/** A file type's badge: its short label and its color's name (PDF red, Word blue, …). */
export type FileTone = "pdf" | "doc" | "sheet" | "slides" | "image" | "muted"
export function badgeFor(name: string, mediaType: string): { label: string; tone: FileTone } {
  const extension = extensionOf(name)
  if (mediaType === "application/pdf" || extension === "pdf") return { label: "PDF", tone: "pdf" }
  if (["doc", "docx", "rtf", "pages"].includes(extension)) return { label: "DOC", tone: "doc" }
  if (["xls", "xlsx", "numbers"].includes(extension)) return { label: "XLSX", tone: "sheet" }
  if (["ppt", "pptx", "key"].includes(extension)) return { label: extension === "key" ? "KEY" : "PPT", tone: "slides" }
  if (["csv", "tsv"].includes(extension)) return { label: "CSV", tone: "sheet" }
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(extension)) return { label: extension.toUpperCase().slice(0, 4), tone: "image" }
  return { label: (extension || mediaType.split("/").pop() || "file").slice(0, 4).toUpperCase(), tone: "muted" }
}

const KIND_NAMES: Record<string, string> = { DOC: "Document", XLSX: "Spreadsheet", CSV: "Spreadsheet", PPT: "Presentation", KEY: "Presentation", MD: "Note", TXT: "Text" }

/** What kind of file it is, in plain words, for a meta line: "Presentation · 47 KB". */
export function kindLabel(name: string, mediaType: string) {
  if (isImage(mediaType)) return "Image"
  const label = badgeFor(name, mediaType).label
  return KIND_NAMES[label] ?? label
}

/** How a file previews: by what the page can read of it. */
export type PreviewKind = "image" | "pdf" | "video" | "audio" | "markdown" | "text" | "csv" | "sheet" | "slides" | "document" | "html" | "other"
export function previewKind(file: Pick<WorkbotAttachment, "name" | "mediaType">): PreviewKind {
  const extension = extensionOf(file.name)
  const type = file.mediaType.toLowerCase()
  if (isImage(type) || ["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image"
  if (type === "application/pdf" || extension === "pdf") return "pdf"
  if (type.startsWith("video/") || ["mp4", "mov", "webm", "m4v"].includes(extension)) return "video"
  if (type.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg"].includes(extension)) return "audio"
  if (["md", "markdown"].includes(extension)) return "markdown"
  if (["csv", "tsv"].includes(extension)) return "csv"
  if (extension === "xlsx") return "sheet"
  if (extension === "pptx") return "slides"
  if (extension === "docx") return "document"
  if (["html", "htm"].includes(extension)) return "html"
  if (type.startsWith("text/") || ["txt", "json", "yaml", "yml", "xml", "log", "py", "js", "ts", "sql"].includes(extension)) return "text"
  return "other"
}

/** CSV/TSV with quoted cells and escaped quotes (the desktop app's artifact parser). */
export function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    const next = content[index + 1]
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"'
        index += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(cell)
      cell = ""
    } else if (char === "\n") {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else if (char !== "\r") {
      cell += char
    }
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.length ? rows : [[""]]
}

/** A sheet shown as a grid stops at this many rows, so huge sheets stay quick. */
export const GRID_MAX_ROWS = 1_000

/** Logos for the apps Workbot uses, by name: Den's bundled icons first, then Simple Icons, then the site's favicon. */
const APP_HINTS: Record<string, { slug?: string; site?: string }> = {
  asana: { slug: "asana" },
  confluence: { slug: "confluence" },
  figma: { slug: "figma" },
  github: { slug: "github" },
  gmail: { slug: "gmail" },
  "google calendar": { slug: "googlecalendar" },
  "google drive": { slug: "googledrive" },
  "google workspace": { site: "google.com" },
  granola: { slug: "granola" },
  hubspot: { slug: "hubspot" },
  jira: { slug: "jira" },
  linear: { site: "linear.app" },
  "microsoft 365": { site: "microsoft.com" },
  notion: { site: "notion.com" },
  salesforce: { slug: "salesforce" },
  sentry: { site: "sentry.io" },
  slack: { site: "slack.com" },
  stripe: { site: "stripe.com" },
  zendesk: { slug: "zendesk" },
}
const DEN_ICONS: Record<string, string> = {
  "notion.com": "/integrations/notion.svg",
  "linear.app": "/integrations/linear.svg",
  "slack.com": "/integrations/slack.svg",
  "stripe.com": "/integrations/stripe.svg",
  "sentry.io": "/integrations/sentry.svg",
  "google.com": "/integrations/google.svg",
}

export function appIconCandidates(name: string, denUrl: string | null): string[] {
  const hint = APP_HINTS[name.trim().toLowerCase()]
  if (!hint) return []
  const candidates: string[] = []
  const bundled = hint.site ? DEN_ICONS[hint.site] : undefined
  if (bundled && denUrl) candidates.push(`${denUrl}${bundled}`)
  if (hint.slug) candidates.push(`https://cdn.simpleicons.org/${encodeURIComponent(hint.slug)}`)
  if (hint.site) candidates.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hint.site)}`)
  return candidates
}

/** The display name of each everyday app on the welcome's connect step. */
export const EVERYDAY_APP_NAMES = { gmail: "Gmail", slack: "Slack", microsoft: "Microsoft 365" } as const
