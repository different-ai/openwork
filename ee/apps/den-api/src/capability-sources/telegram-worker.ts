import { randomBytes } from "node:crypto"
import { and, asc, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import {
  WorkerInstanceTable,
  WorkerTable,
  WorkerTokenTable,
} from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { customDomainForWorker } from "../workers/vanity-domain.js"

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const DEFAULT_PROMPT_TIMEOUT_MS = 120_000

export type TelegramWorkerAccess = {
  candidates: string[]
  clientToken: string
  hostToken: string
  workerId: DenTypeId<"worker">
}

type WorkerTarget = {
  access: TelegramWorkerAccess
  baseUrl: string
  workspaceId: string
}

type AssistantReply = {
  id: string
  parentId: string | null
  text: string
}

export class TelegramWorkerRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "TelegramWorkerRequestError"
    this.status = status
  }
}

export class TelegramWorkerTimeoutError extends Error {
  constructor() {
    super("The worker did not finish before the Telegram response deadline.")
    this.name = "TelegramWorkerTimeoutError"
  }
}

export function isRetryableTelegramWorkerError(error: unknown): boolean {
  return error instanceof TelegramWorkerTimeoutError
    || (error instanceof TelegramWorkerRequestError
      && (error.status === 408 || error.status === 429 || error.status >= 500))
}

export function telegramWorkerIsHealthy(workerStatus: string, instanceStatus: string): boolean {
  return workerStatus === "healthy" && instanceStatus === "healthy"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function workerCandidates(workerId: DenTypeId<"worker">, instanceUrl: string): string[] {
  const candidates: string[] = []
  const vanityHostname = customDomainForWorker(workerId, env.render.workerPublicDomainSuffix)
  if (vanityHostname) candidates.push(`https://${vanityHostname}`)

  const normalizedInstanceUrl = normalizeUrl(instanceUrl)
  if (normalizedInstanceUrl && !candidates.includes(normalizedInstanceUrl)) {
    candidates.push(normalizedInstanceUrl)
  }
  return candidates
}

export async function loadTelegramWorkerAccess(input: {
  organizationId: DenTypeId<"organization">
  workerId: DenTypeId<"worker">
}): Promise<TelegramWorkerAccess | null> {
  const workerRows = await db
    .select({ id: WorkerTable.id, status: WorkerTable.status })
    .from(WorkerTable)
    .where(and(
      eq(WorkerTable.id, input.workerId),
      eq(WorkerTable.org_id, input.organizationId),
      eq(WorkerTable.status, "healthy"),
    ))
    .limit(1)

  if (!workerRows[0]) return null

  const [instances, tokens] = await Promise.all([
    db
      .select({ status: WorkerInstanceTable.status, url: WorkerInstanceTable.url })
      .from(WorkerInstanceTable)
      .where(eq(WorkerInstanceTable.worker_id, input.workerId))
      .orderBy(desc(WorkerInstanceTable.created_at))
      .limit(1),
    db
      .select({ scope: WorkerTokenTable.scope, token: WorkerTokenTable.token })
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, input.workerId), isNull(WorkerTokenTable.revoked_at)))
      .orderBy(asc(WorkerTokenTable.created_at)),
  ])

  const instanceUrl = instances[0]?.url
  const instanceStatus = instances[0]?.status
  const hostToken = tokens.find((entry) => entry.scope === "host")?.token
  const clientToken = tokens.find((entry) => entry.scope === "client")?.token
  if (
    !instanceUrl
    || !instanceStatus
    || !telegramWorkerIsHealthy(workerRows[0].status, instanceStatus)
    || !hostToken
    || !clientToken
  ) return null

  return {
    candidates: workerCandidates(input.workerId, instanceUrl),
    clientToken,
    hostToken,
    workerId: input.workerId,
  }
}

function workerHeaders(access: TelegramWorkerAccess, hasBody: boolean): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${access.clientToken}`,
    "X-OpenWork-Host-Token": access.hostToken,
  })
  if (hasBody) headers.set("Content-Type", "application/json")
  return headers
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

function payloadMessage(payload: unknown): string {
  if (isRecord(payload) && typeof payload.message === "string") return payload.message
  if (isRecord(payload) && typeof payload.error === "string") return payload.error
  return "Worker request failed."
}

async function fetchWorkerJson(input: {
  access: TelegramWorkerAccess
  baseUrl: string
  body?: unknown
  fetchImpl: typeof fetch
  method?: "GET" | "POST"
  path: string
  requestTimeoutMs: number
}): Promise<unknown> {
  const hasBody = input.body !== undefined
  let response: Response
  try {
    response = await input.fetchImpl(`${normalizeUrl(input.baseUrl)}${input.path}`, {
      body: hasBody ? JSON.stringify(input.body) : undefined,
      headers: workerHeaders(input.access, hasBody),
      method: input.method ?? "GET",
      signal: AbortSignal.timeout(input.requestTimeoutMs),
    })
  } catch (error) {
    throw new TelegramWorkerRequestError(502, errorMessage(error))
  }

  const payload = await readResponsePayload(response)
  if (!response.ok) {
    throw new TelegramWorkerRequestError(
      response.status,
      `Worker request failed (${response.status}): ${payloadMessage(payload)}`,
    )
  }
  return payload
}

function workspaceIdFromPayload(payload: unknown, preferredWorkspaceId?: string): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null

  const ids = payload.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) return []
    return [item.id]
  })

  if (preferredWorkspaceId && ids.includes(preferredWorkspaceId)) return preferredWorkspaceId
  if (typeof payload.activeId === "string" && ids.includes(payload.activeId)) return payload.activeId
  return ids[0] ?? null
}

async function resolveWorkerTarget(input: {
  access: TelegramWorkerAccess
  fetchImpl: typeof fetch
  preferredWorkspaceId?: string
  requestTimeoutMs: number
}): Promise<WorkerTarget> {
  let lastError: TelegramWorkerRequestError | null = null

  for (const baseUrl of input.access.candidates) {
    try {
      const payload = await fetchWorkerJson({
        access: input.access,
        baseUrl,
        fetchImpl: input.fetchImpl,
        path: "/workspaces",
        requestTimeoutMs: input.requestTimeoutMs,
      })
      const workspaceId = workspaceIdFromPayload(payload, input.preferredWorkspaceId)
      if (!workspaceId) {
        throw new TelegramWorkerRequestError(409, "The selected worker has no workspace.")
      }
      return { access: input.access, baseUrl, workspaceId }
    } catch (error) {
      const normalized = error instanceof TelegramWorkerRequestError
        ? error
        : new TelegramWorkerRequestError(502, errorMessage(error))
      lastError = normalized
      if (normalized.status >= 400 && normalized.status < 500) throw normalized
    }
  }

  throw lastError ?? new TelegramWorkerRequestError(502, "The selected worker is unreachable.")
}

function sessionIdFromPayload(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.id !== "string" || !payload.id.trim()) return null
  return payload.id
}

function snapshotItem(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || !isRecord(payload.item)) return null
  return payload.item
}

function snapshotIsIdle(payload: unknown): boolean {
  const item = snapshotItem(payload)
  return Boolean(item && isRecord(item.status) && item.status.type === "idle")
}

function snapshotHasMessage(payload: unknown, messageId: string): boolean {
  const item = snapshotItem(payload)
  if (!item || !Array.isArray(item.messages)) return false
  return item.messages.some((message) => (
    isRecord(message)
    && isRecord(message.info)
    && message.info.id === messageId
  ))
}

export function assistantRepliesFromSnapshot(payload: unknown): AssistantReply[] {
  const item = snapshotItem(payload)
  if (!item || !Array.isArray(item.messages)) return []

  const replies: AssistantReply[] = []
  for (const message of item.messages) {
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant") continue
    if (typeof message.info.id !== "string" || !Array.isArray(message.parts)) continue
    const text = message.parts.flatMap((part) => {
      if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return []
      const trimmed = part.text.trim()
      return trimmed ? [trimmed] : []
    }).join("\n")
    if (text) {
      replies.push({
        id: message.info.id,
        parentId: typeof message.info.parentID === "string" ? message.info.parentID : null,
        text,
      })
    }
  }
  return replies
}

async function createSession(input: {
  fetchImpl: typeof fetch
  requestTimeoutMs: number
  target: WorkerTarget
}): Promise<string> {
  const payload = await fetchWorkerJson({
    access: input.target.access,
    baseUrl: input.target.baseUrl,
    body: { title: "Telegram chat" },
    fetchImpl: input.fetchImpl,
    method: "POST",
    path: `/workspace/${encodeURIComponent(input.target.workspaceId)}/opencode/session`,
    requestTimeoutMs: input.requestTimeoutMs,
  })
  const sessionId = sessionIdFromPayload(payload)
  if (!sessionId) {
    throw new TelegramWorkerRequestError(502, "The worker created a session without an id.")
  }
  return sessionId
}

async function readSnapshot(input: {
  fetchImpl: typeof fetch
  requestTimeoutMs: number
  sessionId: string
  target: WorkerTarget
}) {
  return fetchWorkerJson({
    access: input.target.access,
    baseUrl: input.target.baseUrl,
    fetchImpl: input.fetchImpl,
    path: `/workspace/${encodeURIComponent(input.target.workspaceId)}/sessions/${encodeURIComponent(input.sessionId)}/snapshot?limit=100`,
    requestTimeoutMs: input.requestTimeoutMs,
  })
}

export async function runTelegramWorkerPrompt(input: {
  access: TelegramWorkerAccess
  fetchImpl?: typeof fetch
  pollIntervalMs?: number
  preferredWorkspaceId?: string
  messageId?: string
  onSessionReady?: (session: { sessionId: string; workspaceId: string }) => Promise<void>
  promptTimeoutMs?: number
  requestTimeoutMs?: number
  sessionId?: string
  text: string
}): Promise<{ sessionId: string; text: string; workspaceId: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const promptTimeoutMs = input.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
  const requestTimeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const messageId = input.messageId ?? `msg_${randomBytes(16).toString("hex")}`
  const target = await resolveWorkerTarget({
    access: input.access,
    fetchImpl,
    preferredWorkspaceId: input.preferredWorkspaceId,
    requestTimeoutMs,
  })

  let sessionId = input.sessionId
  let baselineSnapshot: unknown = null
  if (sessionId) {
    try {
      baselineSnapshot = await readSnapshot({ fetchImpl, requestTimeoutMs, sessionId, target })
    } catch (error) {
      if (!(error instanceof TelegramWorkerRequestError) || error.status !== 404) throw error
      sessionId = undefined
    }
  }

  if (!sessionId) {
    sessionId = await createSession({ fetchImpl, requestTimeoutMs, target })
    baselineSnapshot = await readSnapshot({ fetchImpl, requestTimeoutMs, sessionId, target })
  }

  await input.onSessionReady?.({ sessionId, workspaceId: target.workspaceId })

  const completedReply = assistantRepliesFromSnapshot(baselineSnapshot).find((reply) => reply.parentId === messageId)
  if (snapshotIsIdle(baselineSnapshot) && completedReply) {
    return { sessionId, text: completedReply.text, workspaceId: target.workspaceId }
  }

  if (!snapshotHasMessage(baselineSnapshot, messageId)) {
    await fetchWorkerJson({
      access: target.access,
      baseUrl: target.baseUrl,
      body: { messageID: messageId, parts: [{ type: "text", text: input.text }] },
      fetchImpl,
      method: "POST",
      path: `/workspace/${encodeURIComponent(target.workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/prompt_async`,
      requestTimeoutMs,
    })
  }

  const deadline = Date.now() + promptTimeoutMs
  while (Date.now() < deadline) {
    const snapshot = await readSnapshot({ fetchImpl, requestTimeoutMs, sessionId, target })
    const newReplies = assistantRepliesFromSnapshot(snapshot).filter(
      (reply) => reply.parentId === messageId,
    )
    if (snapshotIsIdle(snapshot) && newReplies.length > 0) {
      const reply = newReplies[newReplies.length - 1]
      if (reply) {
        return { sessionId, text: reply.text, workspaceId: target.workspaceId }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }

  throw new TelegramWorkerTimeoutError()
}
