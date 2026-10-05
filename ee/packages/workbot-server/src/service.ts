import { createHash } from "node:crypto"
import type { HeadlessRunnerClient, RunnerSavedFile } from "@openwork-ee/headless-protocol"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { buildWorkbotTurns, interruptedTurnId, threadBusy, WORKBOT_MESSAGE_PREFIX, type WorkbotTurn } from "./thread.js"

/**
 * Workbot: one chat per person, set up once by an admin. Each member has a
 * single durable conversation on the headless runner, reaches their apps
 * through OpenWork MCP with a token minted per turn, and keeps long-term
 * memory as files under memory/ in that conversation, which the runner shows
 * the model every turn. Nothing is configured here.
 *
 * The host (the Workbot app, ee/apps/workbot) signs the member in through Den, which decides whether Workbot is on
 * for their organization; the host passes in the runner client. Everything else about Workbot lives here.
 */

export type WorkbotActor = {
  organizationId: string
  organizationName: string
  /** The organization's metadata (an object or its JSON), read for its brand name. */
  organizationMetadata: unknown
  memberId: string
  userId: string
  firstName: string | null
}

export type WorkbotThread = {
  name: string
  organizationName: string
  status: "idle" | "busy"
  turns: WorkbotTurn[]
  hasEarlier: boolean
  /** Whether this deployment keeps files (the runner has a blob store). */
  filesEnabled: boolean
}

export type WorkbotFile = RunnerSavedFile

export type WorkbotDeps = {
  /** The headless runner, or null when this deployment has none. */
  client: HeadlessRunnerClient | null
  /** Whether Workbot may set up recurring work (Automations on the headless runner) for this organization. */
  canSchedule: (organizationId: string) => Promise<boolean>
}

/** Derived, so each member has exactly one thread and Den stores nothing to find it. */
export function workbotSessionId(organizationId: string, memberId: string) {
  return `hs_wb_${createHash("sha256").update(`workbot:${organizationId}:${memberId}`).digest("hex").slice(0, 40)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMetadata(metadata: WorkbotActor["organizationMetadata"]): Record<string, unknown> {
  if (typeof metadata !== "string") return isRecord(metadata) ? metadata : {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The organization's own app name when it set one (Settings → Brand), otherwise Workbot. */
export function workbotName(metadata: WorkbotActor["organizationMetadata"]) {
  const brand = parseMetadata(metadata).brandAppName
  return typeof brand === "string" && brand.trim() && brand.trim() !== "OpenWork" ? brand.trim().slice(0, 40) : "Workbot"
}

export function workbotInstructions(input: {
  name: string
  organizationName: string
  firstName: string | null
  timeZone: string
  canSchedule: boolean
  now?: Date
}) {
  const localNow = (input.now ?? new Date()).toLocaleString("en-US", {
    timeZone: input.timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  })
  const person = input.firstName ?? "this person"
  return [
    `You are ${input.name}, the assistant ${input.organizationName} set up for ${person}. This is your one ongoing conversation with them; it never resets.`,
    "",
    `- ${person} is not technical. Never mention tools, MCP, capabilities, models, prompts, files or settings. Write like a helpful coworker: short, plain sentences.`,
    "- Reach their connected apps with search_capabilities, then execute_capability. Look things up before asking them.",
    "- Answer in the chat. Keep replies short; use a short list or a quoted draft when it helps. Before a lookup, say in a few words what you are checking.",
    `- Memory: older messages drop out of what you can see, but files under memory/ are always shown to you. Keep them current without being asked: who ${person} is and how they like to work (memory/about.md), the people, projects and threads they care about (memory/people.md, memory/projects.md), and anything they ask you to remember. Write facts, not transcripts; update or remove what is no longer true. Never tell them you are updating memory unless they asked you to remember something.`,
    "- Ask before you send, post, delete or change anything in their apps, unless they asked for that exact action in this message.",
    input.canSchedule
      ? `- For anything recurring or later ("every Monday at 8", "remind me at 3"), create an Automation: find createCloudAutomation with search_capabilities, then call it with execute_capability. Use their time zone (${input.timeZone}), a short plain name, instructions that make sense on their own later, and model {"providerId":"${AUTOMATION_CLOUD_DEFAULT_MODEL.providerId}","modelId":"${AUTOMATION_CLOUD_DEFAULT_MODEL.modelId}"}. Then confirm in one line.`
      : "- You cannot schedule recurring work here yet. If they ask, say so in one line and offer to do it now instead.",
    `- Their time zone is ${input.timeZone}. When they sent their latest message it was ${localNow} there; say "today" and "tomorrow" from their point of view.`,
  ].join("\n")
}

function validTimeZone(value: string | undefined) {
  if (!value) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return value
  } catch {
    return "UTC"
  }
}

export class WorkbotUnavailableError extends Error {
  constructor(readonly code: "workbot_not_enabled" | "workbot_runner_unavailable") {
    super(code)
    this.name = "WorkbotUnavailableError"
  }
}

function clientOf(deps: WorkbotDeps) {
  if (!deps.client) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return deps.client
}

async function ensureSession(actor: WorkbotActor, timeZone: string, deps: WorkbotDeps) {
  const client = clientOf(deps)
  const name = workbotName(actor.organizationMetadata)
  const canSchedule = await deps.canSchedule(actor.organizationId).catch(() => false)
  const saved = await client.putSession(workbotSessionId(actor.organizationId, actor.memberId), {
    title: `${name} · ${actor.firstName ?? "member"}`,
    instructions: workbotInstructions({
      name,
      organizationName: actor.organizationName,
      firstName: actor.firstName,
      timeZone,
      canSchedule,
    }),
    // Workbot keeps the person's files and works on its own computer; the runner offers them only on request.
    files: true,
    computer: true,
  })
  if (!saved.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return saved.value.id
}

/** Turns shown per page of the conversation; earlier ones load on request. */
export const WORKBOT_PAGE_TURNS = 30

export async function readWorkbotThread(
  actor: WorkbotActor,
  input: { turns?: number },
  deps: WorkbotDeps,
): Promise<WorkbotThread> {
  const client = clientOf(deps)
  const sessionId = workbotSessionId(actor.organizationId, actor.memberId)
  const name = workbotName(actor.organizationMetadata)
  // Windowed: reading a year-long thread costs the same as reading a new one.
  const read = await client.readSession(sessionId, { turns: input.turns ?? WORKBOT_PAGE_TURNS, limit: 2_000, outputs: "none" })
  if (!read.ok && read.status === 404) {
    // First visit: no thread yet. It is created with the first message.
    return { name, organizationName: actor.organizationName, status: "idle", turns: [], hasEarlier: false, filesEnabled: await client.filesEnabled() }
  }
  if (!read.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")

  // A runner restart interrupts the running turn; re-sending its id resumes it with a fresh token.
  const interrupted = interruptedTurnId(read.value)
  if (interrupted) {
    await client.sendTurn({ userId: actor.userId, organizationId: actor.organizationId }, { sessionId, messageId: interrupted, prompt: "resume" }).catch(() => null)
  }

  const filesEnabled = await client.filesEnabled()
  const files = filesEnabled ? await client.listFiles(sessionId) : null
  const names = new Map(
    (files?.ok ? files.value : []).map((file) => [
      file.id,
      { name: file.name, createdAt: file.createdAt, updatedAt: file.updatedAt, mediaType: file.mediaType, size: file.size, source: file.source },
    ]),
  )
  return {
    name,
    organizationName: actor.organizationName,
    status: threadBusy(read.value) ? "busy" : "idle",
    turns: buildWorkbotTurns(read.value, names),
    hasEarlier: read.value.hasEarlier ?? false,
    filesEnabled,
  }
}

export async function sendWorkbotMessage(
  actor: WorkbotActor,
  input: { id: string; text: string; timeZone?: string; attachments?: string[] },
  deps: WorkbotDeps,
) {
  const client = clientOf(deps)
  const sessionId = await ensureSession(actor, validTimeZone(input.timeZone), deps)
  // The page's own id makes retries safe: the runner never starts a second turn for it.
  const sent = await client.sendTurn(
    { userId: actor.userId, organizationId: actor.organizationId },
    { sessionId, messageId: `${WORKBOT_MESSAGE_PREFIX}${input.id}`, prompt: input.text, attachments: input.attachments },
  )
  if (!sent.ok && sent.status === 400 && sent.error === "unknown_file") return { ok: false as const, code: "unknown_file" as const }
  if (!sent.ok && sent.status === 429) return { ok: false as const, code: "too_many_queued" as const }
  if (!sent.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { ok: true as const }
}

export async function stopWorkbot(actor: WorkbotActor, deps: WorkbotDeps) {
  const stopped = await clientOf(deps).abort(workbotSessionId(actor.organizationId, actor.memberId))
  return { stopped: stopped.stopped }
}

/** The member's live event stream from the runner, or null when it can't be opened. */
export async function openWorkbotEvents(actor: WorkbotActor, signal: AbortSignal, deps: WorkbotDeps) {
  return clientOf(deps).openEvents(workbotSessionId(actor.organizationId, actor.memberId), signal).catch(() => null)
}

export class WorkbotFilesUnavailableError extends Error {
  constructor() {
    super("workbot_files_not_configured")
    this.name = "WorkbotFilesUnavailableError"
  }
}

/** Keeps a file the member sends; it is attached to a message by id when they send it. */
export async function uploadWorkbotFile(
  actor: WorkbotActor,
  input: { name: string; mediaType: string; bytes: ArrayBuffer; timeZone?: string },
  deps: WorkbotDeps,
) {
  const client = clientOf(deps)
  if (!(await client.filesEnabled())) throw new WorkbotFilesUnavailableError()
  // The thread exists before its first message so a file can be added first.
  const sessionId = await ensureSession(actor, validTimeZone(input.timeZone), deps)
  const uploaded = await client.uploadFile(sessionId, input)
  if (!uploaded.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return uploaded.value
}

export async function listWorkbotFiles(actor: WorkbotActor, deps: WorkbotDeps): Promise<{ enabled: boolean; files: WorkbotFile[] }> {
  const client = clientOf(deps)
  if (!(await client.filesEnabled())) return { enabled: false, files: [] }
  const listed = await client.listFiles(workbotSessionId(actor.organizationId, actor.memberId))
  if (!listed.ok && listed.status === 404) return { enabled: true, files: [] }
  if (!listed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { enabled: true, files: listed.value }
}

export async function downloadWorkbotFile(actor: WorkbotActor, fileId: string, deps: WorkbotDeps) {
  return clientOf(deps).downloadFile(workbotSessionId(actor.organizationId, actor.memberId), fileId)
}

export async function readWorkbotPreview(actor: WorkbotActor, fileId: string, deps: WorkbotDeps) {
  return clientOf(deps).previewManifest(workbotSessionId(actor.organizationId, actor.memberId), fileId)
}

export async function downloadWorkbotPreviewPage(actor: WorkbotActor, fileId: string, page: number, deps: WorkbotDeps) {
  return clientOf(deps).previewPage(workbotSessionId(actor.organizationId, actor.memberId), fileId, page)
}

export async function deleteWorkbotFile(actor: WorkbotActor, fileId: string, deps: WorkbotDeps) {
  return clientOf(deps).deleteFile(workbotSessionId(actor.organizationId, actor.memberId), fileId)
}

/** Workbot for one host: every operation, bound to its runner and scheduling check. */
export function createWorkbot(deps: WorkbotDeps) {
  return {
    readThread: (actor: WorkbotActor, input: { turns?: number } = {}) => readWorkbotThread(actor, input, deps),
    send: (actor: WorkbotActor, input: { id: string; text: string; timeZone?: string; attachments?: string[] }) => sendWorkbotMessage(actor, input, deps),
    stop: (actor: WorkbotActor) => stopWorkbot(actor, deps),
    openEvents: (actor: WorkbotActor, signal: AbortSignal) => openWorkbotEvents(actor, signal, deps),
    uploadFile: (actor: WorkbotActor, input: { name: string; mediaType: string; bytes: ArrayBuffer; timeZone?: string }) => uploadWorkbotFile(actor, input, deps),
    listFiles: (actor: WorkbotActor) => listWorkbotFiles(actor, deps),
    downloadFile: (actor: WorkbotActor, fileId: string) => downloadWorkbotFile(actor, fileId, deps),
    readPreview: (actor: WorkbotActor, fileId: string) => readWorkbotPreview(actor, fileId, deps),
    downloadPreviewPage: (actor: WorkbotActor, fileId: string, page: number) => downloadWorkbotPreviewPage(actor, fileId, page, deps),
    deleteFile: (actor: WorkbotActor, fileId: string) => deleteWorkbotFile(actor, fileId, deps),
  }
}
export type Workbot = ReturnType<typeof createWorkbot>
