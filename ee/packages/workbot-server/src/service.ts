import { createHash } from "node:crypto"
import type { HeadlessRunnerClient, RunnerSavedFile } from "@openwork-ee/headless-protocol"
import { AUTOMATION_CLOUD_DEFAULT_MODEL } from "@openwork/types/automations"
import { buildWorkbotTurns, GREETING_RUNNER_ID, interruptedTurnIds, threadBusy, WORKBOT_MESSAGE_PREFIX, type WorkbotTurn } from "./thread.js"

/**
 * Workbot: one chat per person, set up once by an admin. Each member has a
 * durable main chat on the headless runner, reaches their apps through OpenWork
 * MCP with a token minted per turn, and keeps long-term memory as files under
 * memory/ in that chat, which the runner shows the model every turn. Where side
 * chats are on, a member can also start side chats for one topic at a time; they
 * share the main chat's memory. Nothing is configured here.
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

/** Which of the person's chats: their main chat (null), or one of their side chats by its id. */
export type WorkbotChat = string | null

export type WorkbotThread = {
  name: string
  organizationName: string
  status: "idle" | "busy"
  turns: WorkbotTurn[]
  hasEarlier: boolean
  /** Whether this deployment keeps files (the runner has a blob store). */
  filesEnabled: boolean
}

/** A chat in the person's list: its id (null for the main chat), its name once it has one, and when it was last used. */
export type WorkbotChatSummary = { id: string; title: string; updatedAt: number }

export type WorkbotFile = RunnerSavedFile

export type WorkbotDeps = {
  /** The headless runner, or null when this deployment has none. */
  client: HeadlessRunnerClient | null
  /** Whether Workbot may set up recurring work (Automations on the headless runner) for this organization. */
  canSchedule: (organizationId: string) => Promise<boolean>
}

const personKey = (organizationId: string, memberId: string) => createHash("sha256").update(`workbot:${organizationId}:${memberId}`).digest("hex").slice(0, 40)

/** Derived, so each member has exactly one main chat and Den stores nothing to find it. */
export function workbotSessionId(organizationId: string, memberId: string) {
  return `hs_wb_${personKey(organizationId, memberId)}`
}

/** A side chat's id, made by the page when the person starts one. */
export const WORKBOT_CHAT_ID = /^[a-z0-9]{16,40}$/

/** The runner lists a person's chats by this key: derived from them, never their raw ids. */
export function workbotOwner(organizationId: string, memberId: string) {
  return `wb:${personKey(organizationId, memberId)}`
}

/** A side chat's conversation: derived from the person and the chat's id, so nobody can reach another person's chat. */
export function workbotSideChatSessionId(organizationId: string, memberId: string, chatId: string) {
  return `hs_wbs_${createHash("sha256").update(`workbot:${organizationId}:${memberId}:${chatId}`).digest("hex").slice(0, 40)}`
}

/** The runner's ref for the main chat in the person's list; side chats use their own id. */
const MAIN_CHAT_REF = "main"

function sessionOf(actor: WorkbotActor, chat: WorkbotChat) {
  return chat ? workbotSideChatSessionId(actor.organizationId, actor.memberId, chat) : workbotSessionId(actor.organizationId, actor.memberId)
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

/**
 * The model's instructions for one of the person's chats. They stay the same from one message to the next (the
 * runner dates each message instead), so the model provider's prompt cache keeps hitting.
 */
export function workbotInstructions(input: {
  name: string
  organizationName: string
  firstName: string | null
  timeZone: string
  canSchedule: boolean
  /** A side chat: one topic, next to their main chat, with the same memory. */
  side?: boolean
}) {
  const person = input.firstName ?? "this person"
  return [
    input.side
      ? `You are ${input.name}, the assistant ${input.organizationName} set up for ${person}. This is a side chat ${person} started for one topic, next to their main chat with you. You share the same memory across their chats.`
      : `You are ${input.name}, the assistant ${input.organizationName} set up for ${person}. This is your one ongoing conversation with them; it never resets.`,
    "",
    `- ${person} watches this chat live and sees each thing you write as you write it, not only your final message. So sound like a person taking it on: in the same reply where you first use your computer or look through their apps, start with one short sentence of your own before the tool call ("Sure, give me a sec.", "Let me check your inbox."), then do the work, then answer in its own short message. Vary the words; skip it only when the answer is instant.`,
    `- ${person} is not technical. Never mention tools, MCP, capabilities, models, prompts, files or settings. Write like a helpful coworker: short, plain sentences.`,
    "- Reach their connected apps with search_capabilities, then execute_capability. Look things up before asking them.",
    "- Answer in the chat. Keep replies short; use a short list or a quoted draft when it helps.",
    "- Like a colleague, take bigger jobs away and come back with them: hand anything more than a quick look to start_task and tell them in a few words that you're on it. When a task reports back, give them what matters in a line or two and the obvious next step.",
    "- Say a background job has started only after start_task succeeds. If it cannot start, say so; never promise a result from work that isn't running.",
    "- React to their message with one emoji (react) when a colleague would, before you reply: 👍 when you're on it or agree, ❤️ for thanks, 😮 or ‼️ when they tell you something surprising, 😂 when it's funny, 🎉 for good news. Not on every message. When a reaction is all a colleague would send back (\"thanks!\", \"ok\", \"sounds good\"), react with final: that is your whole reply.",
    `- Memory: older messages drop out of what you can see, but files under memory/ are always shown to you. Keep them current without being asked: who ${person} is and how they like to work (memory/about.md), the people, projects and threads they care about (memory/people.md, memory/projects.md), and anything they ask you to remember. Write facts, not transcripts; update or remove what is no longer true. Never tell them you are updating memory unless they asked you to remember something.`,
    "- Ask before you send, post, delete or change anything in their apps, unless they asked for that exact action in this message.",
    input.canSchedule
      ? `- For anything recurring or later ("every Monday at 8", "remind me at 3"), create an Automation: find createCloudAutomation with search_capabilities, then call it with execute_capability. Use their time zone (${input.timeZone}), a short plain name, instructions that make sense on their own later, and model {"providerId":"${AUTOMATION_CLOUD_DEFAULT_MODEL.providerId}","modelId":"${AUTOMATION_CLOUD_DEFAULT_MODEL.modelId}"}. Then confirm in one line.`
      : "- You cannot schedule recurring work here yet. If they ask, say so in one line and offer to do it now instead.",
    `- Their time zone is ${input.timeZone}; each of their messages shows when they sent it, in that time zone. Say "today" and "tomorrow" from their point of view.`,
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

/**
 * Creates or refreshes the chat's conversation on the runner and returns its id. A side chat needs the main chat
 * to exist first: it keeps its memory there.
 */
async function ensureSession(actor: WorkbotActor, timeZone: string, deps: WorkbotDeps, chat: WorkbotChat = null) {
  const client = clientOf(deps)
  const name = workbotName(actor.organizationMetadata)
  const canSchedule = await deps.canSchedule(actor.organizationId).catch(() => false)
  const main = workbotSessionId(actor.organizationId, actor.memberId)
  const common = {
    // Workbot keeps the person's files, works on its own computer, reacts to messages with an emoji and hands longer
    // work to background tasks; the runner offers each only on request.
    files: true,
    computer: true,
    reactions: true,
    tasks: true,
    owner: workbotOwner(actor.organizationId, actor.memberId),
    timeZone,
  }
  const savedMain = await client.putSession(main, {
    title: `${name} · ${actor.firstName ?? "member"}`,
    instructions: workbotInstructions({ name, organizationName: actor.organizationName, firstName: actor.firstName, timeZone, canSchedule }),
    ...common,
    ref: MAIN_CHAT_REF,
  })
  if (!savedMain.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  if (!chat) return savedMain.value.id
  // Named by the runner after its first answer; never sent a title, so that name stays. Strict: a side chat is only
  // found again through its owner and ref, so it is never kept without them (the main chat's id is derived).
  const saved = await client.putSession(sessionOf(actor, chat), {
    instructions: workbotInstructions({ name, organizationName: actor.organizationName, firstName: actor.firstName, timeZone, canSchedule, side: true }),
    ...common,
    ref: chat,
    autoTitle: true,
    memoryOf: main,
    strict: true,
  })
  if (!saved.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return saved.value.id
}

/** Turns shown per page of the conversation; earlier ones load on request. */
export const WORKBOT_PAGE_TURNS = 30

/**
 * Workbot's first hello, written by Workbot itself on the person's first visit: it looks (read-only; its token can't
 * change anything) at what matters to them today and says it in a few lines, then offers a few things to ask. The
 * person never sees this prompt; the page shows only Workbot's message.
 */
export function greetingPrompt(input: { firstName: string | null; timeZone: string; now?: Date }) {
  const person = input.firstName ?? "this person"
  const localNow = (input.now ?? new Date()).toLocaleString("en-US", {
    timeZone: input.timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
  })
  // Natural replies: the page has already said hello by name, so Workbot says what it is doing and fills in the day
  // as it looks, like any other reply.
  return [
    `[${person} just opened Workbot for the first time. It is ${localNow} for them. The page already greeted them by name and showed the apps they connected, and they are watching this conversation. Speak first; they haven't written anything yet.]`,
    "",
    `- Don't say hello again. Start with one short sentence of your own before you look ("Let me look at your day."), then look at what's useful for them right now with their connected apps: today's calendar and the emails waiting on them, asked for together, and anything else connected. You can only read; don't try to send or change anything.`,
    "- Then at most two specific things that need them today (with times), then one offer of help with the most useful one. Keep it to a few short lines.",
    "- If nothing is connected or nothing stands out, say in one line what you can do for them.",
    "- Never mention tools, apps you couldn't reach, or this note. Don't react with an emoji, don't start a background task, and don't save memory yet.",
    "- End with one last line that starts with \"Next:\" and lists two or three short things they could ask you next, separated by \" | \", each under six words and specific to what you found.",
  ].join("\n")
}

/**
 * Workbot says hello first, once the person leaves the welcome screen: it starts the conversation with a turn of its
 * own. Only for a main chat that doesn't exist yet; the fixed id makes it happen once, however many tabs ask.
 */
export async function startWorkbotGreeting(actor: WorkbotActor, input: { timeZone?: string }, deps: WorkbotDeps) {
  const client = clientOf(deps)
  const sessionId = workbotSessionId(actor.organizationId, actor.memberId)
  const read = await client.readSession(sessionId, { turns: 1, limit: 1, outputs: "none" })
  if (read.ok && read.value.turns.length > 0) {
    const greeting = read.value.turns[0]
    if (greeting?.messageId !== GREETING_RUNNER_ID || !["failed", "aborted"].includes(greeting.status)) return { started: false }
    const removed = await client.deleteTurns(sessionId, GREETING_RUNNER_ID)
    if (!removed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  }
  if (!read.ok && read.status !== 404) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  const timeZone = validTimeZone(input.timeZone)
  await ensureSession(actor, timeZone, deps)
  const sent = await client.sendTurn(
    { userId: actor.userId, organizationId: actor.organizationId },
    { sessionId, messageId: GREETING_RUNNER_ID, prompt: greetingPrompt({ firstName: actor.firstName, timeZone }), readOnly: true },
  )
  if (!sent.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { started: true }
}

export async function readWorkbotThread(
  actor: WorkbotActor,
  input: { turns?: number; chat?: WorkbotChat },
  deps: WorkbotDeps,
): Promise<WorkbotThread> {
  const client = clientOf(deps)
  const sessionId = sessionOf(actor, input.chat ?? null)
  const name = workbotName(actor.organizationMetadata)
  // Windowed: reading a year-long thread costs the same as reading a new one.
  const read = await client.readSession(sessionId, { turns: input.turns ?? WORKBOT_PAGE_TURNS, limit: 2_000, outputs: "none" })
  if (!read.ok && read.status === 404) {
    // No conversation yet: the welcome screen starts the main chat (startWorkbotGreeting), the first message any chat.
    return { name, organizationName: actor.organizationName, status: "idle", turns: [], hasEarlier: false, filesEnabled: await client.filesEnabled() }
  }
  if (!read.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")

  // A runner restart, or a long task's token running out, pauses a turn; re-sending its id resumes it with a fresh token.
  for (const interrupted of interruptedTurnIds(read.value)) {
    await client.sendTurn({ userId: actor.userId, organizationId: actor.organizationId }, { sessionId, messageId: interrupted, prompt: "resume", ...(interrupted === GREETING_RUNNER_ID ? { readOnly: true } : {}) }).catch(() => null)
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

/** The person's chats: the main chat (once it exists) and their side chats, most recently used first. */
export async function listWorkbotChats(actor: WorkbotActor, deps: WorkbotDeps): Promise<{ main: { updatedAt: number } | null; side: WorkbotChatSummary[] }> {
  const listed = await clientOf(deps).listSessions(workbotOwner(actor.organizationId, actor.memberId), { limit: 100 })
  if (!listed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  const main = listed.value.sessions.find((session) => session.ref === MAIN_CHAT_REF)
  return {
    main: main ? { updatedAt: main.updatedAt } : null,
    side: listed.value.sessions.flatMap((session) =>
      session.ref && WORKBOT_CHAT_ID.test(session.ref) ? [{ id: session.ref, title: session.title, updatedAt: session.updatedAt }] : [],
    ),
  }
}

/** Removes a side chat with everything in it; refused while it is answering. The main chat can't be removed. */
export async function removeWorkbotChat(actor: WorkbotActor, chatId: string, deps: WorkbotDeps) {
  if (!WORKBOT_CHAT_ID.test(chatId)) return { ok: false as const, code: "unknown_chat" as const }
  const removed = await clientOf(deps).deleteSession(sessionOf(actor, chatId))
  if (!removed.ok && removed.status === 409) return { ok: false as const, code: "busy" as const }
  if (!removed.ok && removed.status === 404) return { ok: false as const, code: "unknown_chat" as const }
  if (!removed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { ok: true as const }
}

export async function sendWorkbotMessage(
  actor: WorkbotActor,
  input: { id: string; text: string; timeZone?: string; attachments?: string[]; chat?: WorkbotChat },
  deps: WorkbotDeps,
) {
  const client = clientOf(deps)
  const sessionId = await ensureSession(actor, validTimeZone(input.timeZone), deps, input.chat ?? null)
  // The page's own id makes retries safe: the runner never starts a second turn for it. A message
  // sent while Workbot answers interrupts that answer, which wraps up keeping what it said, and this one is answered next.
  const sent = await client.sendTurn(
    { userId: actor.userId, organizationId: actor.organizationId },
    { sessionId, messageId: `${WORKBOT_MESSAGE_PREFIX}${input.id}`, prompt: input.text, attachments: input.attachments, interrupt: true },
  )
  if (!sent.ok && sent.status === 400 && sent.error === "unknown_file") return { ok: false as const, code: "unknown_file" as const }
  if (!sent.ok && sent.status === 429) return { ok: false as const, code: "too_many_queued" as const }
  if (!sent.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { ok: true as const }
}

/** One of the person's own messages, by the page's id: never a task, a report or Workbot's hello. */
const MESSAGE_ID = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Answers a message that failed again, in place: the runner resumes the same turn, so the conversation doesn't get a
 * second copy of the message. Only for a message whose answer failed.
 */
export async function retryWorkbotMessage(actor: WorkbotActor, input: { id: string; timeZone?: string; chat?: WorkbotChat }, deps: WorkbotDeps) {
  if (!MESSAGE_ID.test(input.id)) return { ok: false as const, code: "unknown_message" as const }
  const client = clientOf(deps)
  const chat = input.chat ?? null
  const sessionId = sessionOf(actor, chat)
  const messageId = `${WORKBOT_MESSAGE_PREFIX}${input.id}`
  const read = await client.readSession(sessionId, { messageId, limit: 200, outputs: "none" })
  if (!read.ok && read.status === 404) return { ok: false as const, code: "unknown_message" as const }
  if (!read.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  const turn = read.value.turns.find((entry) => entry.messageId === messageId)
  if (!turn) return { ok: false as const, code: "unknown_message" as const }
  if (turn.status !== "failed") return { ok: false as const, code: "not_failed" as const }
  // Fresh instructions and time zone, then the same message id: the runner resumes the turn it already has.
  await ensureSession(actor, validTimeZone(input.timeZone), deps, chat)
  const text = read.value.messages.find((message) => message.role === "user" && message.messageId === messageId)
  const sent = await client.sendTurn(
    { userId: actor.userId, organizationId: actor.organizationId },
    { sessionId, messageId, prompt: text?.role === "user" && text.text.trim() ? text.text : "Try again." },
  )
  if (!sent.ok && sent.status === 429) return { ok: false as const, code: "too_many_queued" as const }
  if (!sent.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { ok: true as const }
}

/**
 * Deletes one of the person's messages with Workbot's answer to it (and anything that answer started), so it is
 * gone from the conversation and from what Workbot remembers of it.
 */
export async function deleteWorkbotMessage(actor: WorkbotActor, id: string, deps: WorkbotDeps, chat: WorkbotChat = null) {
  if (!MESSAGE_ID.test(id)) return { ok: false as const, code: "unknown_message" as const }
  const removed = await clientOf(deps).deleteTurns(sessionOf(actor, chat), `${WORKBOT_MESSAGE_PREFIX}${id}`)
  if (!removed.ok && removed.status === 409) return { ok: false as const, code: "busy" as const }
  if (!removed.ok && removed.status === 404) return { ok: false as const, code: "unknown_message" as const }
  if (!removed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { ok: true as const }
}

/**
 * Edits one of the person's messages: it and everything after it make way for the edited message, which Workbot
 * answers fresh, as if it had been sent that way.
 */
export async function editWorkbotMessage(
  actor: WorkbotActor,
  input: { id: string; newId: string; text: string; timeZone?: string; attachments?: string[]; chat?: WorkbotChat },
  deps: WorkbotDeps,
) {
  if (!MESSAGE_ID.test(input.id) || !MESSAGE_ID.test(input.newId)) return { ok: false as const, code: "unknown_message" as const }
  const removed = await clientOf(deps).deleteTurns(sessionOf(actor, input.chat ?? null), `${WORKBOT_MESSAGE_PREFIX}${input.id}`, {
    andAfter: true,
  })
  if (!removed.ok && removed.status === 409) return { ok: false as const, code: "busy" as const }
  if (!removed.ok && removed.status === 404) return { ok: false as const, code: "unknown_message" as const }
  if (!removed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return sendWorkbotMessage(actor, { id: input.newId, text: input.text, timeZone: input.timeZone, attachments: input.attachments, chat: input.chat ?? null }, deps)
}

/** A background task's page id: the id of the message that started it, then `.t<number>`. */
const TASK_ID = /^[A-Za-z0-9_:-]{1,100}\.t\d{1,3}$/

/** Stops one background task, from its card on the page. It won't report back. */
export async function stopWorkbotTask(actor: WorkbotActor, taskId: string, deps: WorkbotDeps, chat: WorkbotChat = null) {
  if (!TASK_ID.test(taskId)) return { stopped: false }
  const stopped = await clientOf(deps).abort(sessionOf(actor, chat), `${WORKBOT_MESSAGE_PREFIX}${taskId}`)
  return { stopped: stopped.stopped }
}

/** Stops the answer in progress and anything queued behind it; background tasks keep going (Workbot stops one when asked). */
export async function stopWorkbot(actor: WorkbotActor, deps: WorkbotDeps, chat: WorkbotChat = null) {
  const stopped = await clientOf(deps).abort(sessionOf(actor, chat))
  return { stopped: stopped.stopped }
}

/** The chat's live event stream from the runner, or null when it can't be opened. */
export async function openWorkbotEvents(actor: WorkbotActor, signal: AbortSignal, deps: WorkbotDeps, chat: WorkbotChat = null) {
  return clientOf(deps).openEvents(sessionOf(actor, chat), signal).catch(() => null)
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
  input: { name: string; mediaType: string; bytes: ArrayBuffer; timeZone?: string; chat?: WorkbotChat },
  deps: WorkbotDeps,
) {
  const client = clientOf(deps)
  if (!(await client.filesEnabled())) throw new WorkbotFilesUnavailableError()
  // The chat exists before its first message so a file can be added first.
  const sessionId = await ensureSession(actor, validTimeZone(input.timeZone), deps, input.chat ?? null)
  const uploaded = await client.uploadFile(sessionId, input)
  if (!uploaded.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return uploaded.value
}

export async function listWorkbotFiles(actor: WorkbotActor, deps: WorkbotDeps, chat: WorkbotChat = null): Promise<{ enabled: boolean; files: WorkbotFile[] }> {
  const client = clientOf(deps)
  if (!(await client.filesEnabled())) return { enabled: false, files: [] }
  const listed = await client.listFiles(sessionOf(actor, chat))
  if (!listed.ok && listed.status === 404) return { enabled: true, files: [] }
  if (!listed.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { enabled: true, files: listed.value }
}

export async function downloadWorkbotFile(actor: WorkbotActor, fileId: string, deps: WorkbotDeps, chat: WorkbotChat = null) {
  return clientOf(deps).downloadFile(sessionOf(actor, chat), fileId)
}

export async function readWorkbotPreview(actor: WorkbotActor, fileId: string, deps: WorkbotDeps, chat: WorkbotChat = null) {
  return clientOf(deps).previewManifest(sessionOf(actor, chat), fileId)
}

export async function downloadWorkbotPreviewPage(actor: WorkbotActor, fileId: string, page: number, deps: WorkbotDeps, chat: WorkbotChat = null) {
  return clientOf(deps).previewPage(sessionOf(actor, chat), fileId, page)
}

export async function deleteWorkbotFile(actor: WorkbotActor, fileId: string, deps: WorkbotDeps, chat: WorkbotChat = null) {
  return clientOf(deps).deleteFile(sessionOf(actor, chat), fileId)
}

/** Workbot for one host: every operation, bound to its runner and scheduling check. `chat` null is the main chat. */
export function createWorkbot(deps: WorkbotDeps) {
  return {
    readThread: (actor: WorkbotActor, input: { turns?: number; chat?: WorkbotChat } = {}) => readWorkbotThread(actor, input, deps),
    hello: (actor: WorkbotActor, input: { timeZone?: string }) => startWorkbotGreeting(actor, input, deps),
    send: (actor: WorkbotActor, input: { id: string; text: string; timeZone?: string; attachments?: string[]; chat?: WorkbotChat }) =>
      sendWorkbotMessage(actor, input, deps),
    retry: (actor: WorkbotActor, input: { id: string; timeZone?: string; chat?: WorkbotChat }) => retryWorkbotMessage(actor, input, deps),
    stop: (actor: WorkbotActor, chat: WorkbotChat = null) => stopWorkbot(actor, deps, chat),
    stopTask: (actor: WorkbotActor, taskId: string, chat: WorkbotChat = null) => stopWorkbotTask(actor, taskId, deps, chat),
    deleteMessage: (actor: WorkbotActor, id: string, chat: WorkbotChat = null) => deleteWorkbotMessage(actor, id, deps, chat),
    editMessage: (actor: WorkbotActor, input: { id: string; newId: string; text: string; timeZone?: string; attachments?: string[]; chat?: WorkbotChat }) =>
      editWorkbotMessage(actor, input, deps),
    listChats: (actor: WorkbotActor) => listWorkbotChats(actor, deps),
    removeChat: (actor: WorkbotActor, chatId: string) => removeWorkbotChat(actor, chatId, deps),
    openEvents: (actor: WorkbotActor, signal: AbortSignal, chat: WorkbotChat = null) => openWorkbotEvents(actor, signal, deps, chat),
    uploadFile: (actor: WorkbotActor, input: { name: string; mediaType: string; bytes: ArrayBuffer; timeZone?: string; chat?: WorkbotChat }) =>
      uploadWorkbotFile(actor, input, deps),
    listFiles: (actor: WorkbotActor, chat: WorkbotChat = null) => listWorkbotFiles(actor, deps, chat),
    downloadFile: (actor: WorkbotActor, fileId: string, chat: WorkbotChat = null) => downloadWorkbotFile(actor, fileId, deps, chat),
    readPreview: (actor: WorkbotActor, fileId: string, chat: WorkbotChat = null) => readWorkbotPreview(actor, fileId, deps, chat),
    downloadPreviewPage: (actor: WorkbotActor, fileId: string, page: number, chat: WorkbotChat = null) =>
      downloadWorkbotPreviewPage(actor, fileId, page, deps, chat),
    deleteFile: (actor: WorkbotActor, fileId: string, chat: WorkbotChat = null) => deleteWorkbotFile(actor, fileId, deps, chat),
  }
}
export type Workbot = ReturnType<typeof createWorkbot>
