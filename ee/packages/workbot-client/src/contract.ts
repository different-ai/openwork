import { z } from "zod"

/**
 * The Workbot API (`/v1/workbot/...`) as every client sees it: the shapes of its answers, validated on arrival, and
 * its paths. The server is ee/apps/workbot; the conversation itself is shaped by @openwork-ee/workbot-server.
 */

/** The most one message can carry (the runner's limit); longer text goes as a file. */
export const MAX_MESSAGE_CHARS = 100_000
/** The most one file can be (the runner's limit). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
/** Turns shown per page of the conversation, and the most the page asks for. */
export const PAGE_TURNS = 30
export const MAX_TURNS = 200

/** A Workbot path for a chat: a side chat adds `chat=<id>` to it. */
export function inChat(path: string, chat: string | null) {
  if (!chat) return path
  return `${path}${path.includes("?") ? "&" : "?"}chat=${encodeURIComponent(chat)}`
}

/** A side chat's id, made by the client when the person starts one. */
export const CHAT_ID = /^[a-z0-9]{16,40}$/

/** A new side chat's id (24 hex characters) from random bytes. */
export function newChatId(random: (length: number) => Uint8Array) {
  return Array.from(random(12), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** A new message's id (32 hex characters) from random bytes; the server never answers one id twice. */
export function newMessageId(random: (length: number) => Uint8Array) {
  return Array.from(random(16), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export const meSchema = z.object({
  name: z.string().nullable(),
  email: z.string(),
  organizationName: z.string(),
  enabled: z.boolean(),
  /** Workbot's Calendar tab (Den's workbotCalendar feature); older servers omit it. */
  calendar: z.boolean().default(false),
  /** The organization runs Automations in the cloud, so the Calendar can create them. */
  canSchedule: z.boolean().default(false),
  /** Side chats are on for this person (the workbotSideChats feature). */
  sideChats: z.boolean().default(false),
  /** The phone app is on for this person (the workbotMobile feature); older servers omit it. */
  mobile: z.boolean().default(false),
  denUrl: z.string().nullable(),
})
export type WorkbotMe = z.infer<typeof meSchema>

const stepSchema = z.object({
  label: z.string(),
  icon: z.enum(["app", "computer"]),
  status: z.enum(["running", "done"]),
  app: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  updates: z.array(z.string()).default([]),
})
export type WorkbotStep = z.infer<typeof stepSchema>

const partSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("steps"), steps: z.array(stepSchema) }),
])
export type WorkbotPart = z.infer<typeof partSchema>

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["queued", "working", "paused", "done", "failed", "stopped"]),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  update: z.string().nullable().default(null),
  updates: z.array(z.string()).default([]),
})
export type WorkbotTask = z.infer<typeof taskSchema>

const attachmentSchema = z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number(), updatedAt: z.number().optional() })
export type WorkbotAttachment = z.infer<typeof attachmentSchema>

const turnSchema = z.object({
  id: z.string(),
  text: z.string(),
  sentAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  status: z.enum(["queued", "working", "done", "failed", "stopped"]),
  attachments: z.array(attachmentSchema),
  /** Files Workbot made or revised while answering, to open from the answer. `updatedAt` moves with each revision. */
  outputs: z.array(attachmentSchema).default([]),
  /** The emoji Workbot reacted to the message with, shown on the person's bubble. */
  reaction: z.string().nullable().default(null),
  parts: z.array(partSchema),
  modelSteps: z.number(),
  error: z.string().nullable(),
  /** A failed message that can work if answered again: "Try again" answers it again in place. */
  retryable: z.boolean().default(true),
  /** Bigger jobs this message handed to background tasks: shown where they started until they report back. */
  tasks: z.array(taskSchema).default([]),
  /** Workbot's first hello: it spoke first, so there is no message from the person above it. */
  greeting: z.boolean().default(false),
  /** Things the person could ask next, offered as buttons under the hello. */
  suggestions: z.array(z.string()).default([]),
})
export type WorkbotTurn = z.infer<typeof turnSchema>

export const threadSchema = z.discriminatedUnion("available", [
  z.object({ available: z.literal(false), reason: z.enum(["workbot_not_enabled", "workbot_runner_unavailable"]) }),
  z.object({
    available: z.literal(true),
    name: z.string(),
    organizationName: z.string(),
    status: z.enum(["idle", "busy"]),
    turns: z.array(turnSchema),
    hasEarlier: z.boolean(),
    filesEnabled: z.boolean(),
  }),
])
export type WorkbotThread = z.infer<typeof threadSchema>
export type AvailableThread = Extract<WorkbotThread, { available: true }>

export const chatsSchema = z.object({
  main: z.object({ updatedAt: z.number() }).nullable(),
  side: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.number() })),
})
export type WorkbotChats = z.infer<typeof chatsSchema>

export const connectionsSchema = z.object({
  connections: z.array(z.object({
    id: z.string(),
    name: z.string(),
    app: z.enum(["gmail", "slack", "microsoft"]),
    ready: z.boolean(),
    connectUrl: z.string().nullable(),
  })),
})
export type WorkbotConnection = z.infer<typeof connectionsSchema>["connections"][number]

export const fileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  source: z.enum(["user", "agent"]),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
})
export type WorkbotFile = z.infer<typeof fileSchema>
export const filesSchema = z.object({ enabled: z.boolean(), files: z.array(fileSchema) })

export const previewSchema = z.object({ pages: z.number().int().min(1), width: z.number().int().min(1), height: z.number().int().min(1) })
export type WorkbotPreview = z.infer<typeof previewSchema>

/** A person-readable message from a failed response's body, or the fallback. */
export function errorMessage(payload: unknown, fallback: string) {
  if (typeof payload === "object" && payload !== null && "message" in payload && typeof payload.message === "string") return payload.message
  return fallback
}

/** The error code in a failed response's body (`{ error: "…" }`), if any. */
export function errorCode(payload: unknown): string | null {
  return typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string" ? payload.error : null
}
