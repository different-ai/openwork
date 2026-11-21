import { z } from "zod"
import { demonstrationReplySchema, type DemonstrationCommand } from "@openwork/types/browser-demonstration"

/**
 * `owner` routes every call to one owner's cell on a cell runtime (ee/apps/headless-runner/OWNER-CELLS.md). The
 * Node runner ignores it. Only a trusted service sets it, from the person it already authenticated.
 */
export type HeadlessRunnerConfig = { url: string; token: string; owner?: string }

/** UTF-16 character limit enforced at runner turn admission. */
export const HEADLESS_MAX_PROMPT_CHARS = 100_000

export const HEADLESS_OWNER_HEADER = "x-openwork-headless-owner"

function runnerHeaders(config: HeadlessRunnerConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, ...(config.owner ? { [HEADLESS_OWNER_HEADER]: config.owner } : {}), ...extra }
}

function isSafeRunnerUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return true
    return url.protocol === "http:" && (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !url.hostname.includes("."))
  } catch {
    return false
  }
}

export function headlessRunnerConfig(env: Record<string, string | undefined> = process.env): HeadlessRunnerConfig | null {
  const url = env.DEN_HEADLESS_RUNNER_URL?.trim()
  const token = env.DEN_HEADLESS_RUNNER_TOKEN?.trim()
  if (!url || !token || token.length < 32 || !isSafeRunnerUrl(url)) return null
  return { url: withoutTrailingSlashes(url), token }
}

function withoutTrailingSlashes(value: string) {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1
  return value.slice(0, end)
}

/** In-memory inference credentials supplied only by an authenticated, trusted service caller. */
export const headlessModelAccessSchema = z.strictObject({
  baseUrl: z.string().url().max(2048).refine((value) => {
    try {
      const url = new URL(value)
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }),
  apiKey: z.string().min(1).max(4096),
  protocol: z.enum(["anthropic", "openai", "openai-responses"]),
  model: z.string().trim().min(1).max(512).optional(),
})
export type HeadlessModelAccess = z.infer<typeof headlessModelAccessSchema>

export type HeadlessRunnerActor = { userId: string; organizationId: string }

export type HeadlessRunnerDeps = {
  config: HeadlessRunnerConfig
  fetch: typeof fetch
  mintToken: (
    input: HeadlessRunnerActor & { ttlMs?: number; sessionId?: string; messageId?: string; readOnly?: boolean; scopes?: readonly string[]; model?: string; modelAccessRequired?: boolean },
  ) => Promise<{ token: string; resumeGrant?: string; modelAccess?: HeadlessModelAccess; indexCapability?: string }>
  modelAccessRequired?: (actor: HeadlessRunnerActor) => Promise<boolean> | boolean
  modelAccess?: (actor: HeadlessRunnerActor, selection?: { model?: string; modelAccessRequired?: boolean }) => Promise<HeadlessModelAccess | undefined>
  maxTokenTtlMs: number
}

/** queued | running | completed | failed | interrupted | aborted; kept open so a new runner status never breaks reads. */
export type RunnerTurnStatus = string

export const runnerTurnSchema = z.object({
  messageId: z.string(),
  status: z.string(),
  model: z.string().nullable().optional(),
  modelAccessRequired: z.boolean().optional(),
  error: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  kind: z.string().optional(),
  parent: z.string().optional(),
  title: z.string().optional(),
  errorDetail: z.string().optional(),
  prompt: z.string().optional(),
})
export type RunnerTurn = z.infer<typeof runnerTurnSchema>

export const runnerSessionSummarySchema = z.object({
  id: z.string(),
  ref: z.string().nullable(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type RunnerSessionSummary = z.infer<typeof runnerSessionSummarySchema>

const runnerToolCallSchema = z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
export const runnerMessageSchema = z.discriminatedUnion("role", [
  z.object({
    seq: z.number().optional(),
    messageId: z.string().optional(),
    createdAt: z.number().optional(),
    role: z.literal("user"),
    text: z.string(),
    attachments: z.array(z.object({ id: z.string(), name: z.string(), mediaType: z.string(), size: z.number() })).optional(),
  }),
  z.object({
    seq: z.number().optional(),
    messageId: z.string().optional(),
    createdAt: z.number().optional(),
    role: z.literal("assistant"),
    text: z.string(),
    toolCalls: z.array(runnerToolCallSchema),
  }),
  z.object({
    seq: z.number().optional(),
    messageId: z.string().optional(),
    createdAt: z.number().optional(),
    role: z.literal("tool"),
    callId: z.string(),
    name: z.string(),
    output: z.string().optional(),
    isError: z.boolean(),
    imageCount: z.number().optional(),
    app: z.object({ id: z.string(), title: z.string() }).optional(),
  }),
])
export type RunnerMessage = z.infer<typeof runnerMessageSchema>

const runnerSnapshotSchema = z.object({
  turns: z.array(runnerTurnSchema),
  messages: z.array(z.unknown()),
  finalAssistantText: z.string(),
  status: z.string().optional(),
  hasEarlier: z.boolean().optional(),
})

export type RunnerSnapshot = {
  turns: RunnerTurn[]
  messages: RunnerMessage[]
  finalAssistantText: string
  status?: string
  hasEarlier?: boolean
}

export const ACTIVE_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["queued", "running"])
export const TERMINAL_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["completed", "failed", "aborted"])

const modelCatalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string().optional() })),
  verified: z.boolean().optional(),
})
export type HeadlessModelCatalog = z.infer<typeof modelCatalogSchema>

const modelProbeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("answered"), errorCode: z.null(), requestedModel: z.string(), reportedModel: z.string().nullable() }),
  z.strictObject({ status: z.literal("failed"), errorCode: z.enum(["credentials_unavailable", "authentication_failed", "payment_required", "provider_unavailable", "timed_out", "invalid_response", "busy"]), requestedModel: z.string(), reportedModel: z.null() }),
])
export type HeadlessModelProbe = z.infer<typeof modelProbeSchema>

export const runnerSavedFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  source: z.enum(["user", "agent"]),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
})
export type RunnerSavedFile = z.infer<typeof runnerSavedFileSchema>

export type RunnerResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

const COMPUTERS_TIMEOUT_MS = 30_000
const fleetText = z.string().max(2_000).nullable()
const fleetCount = z.number().finite().nullable()
/** One computer as the runner's `GET /v1/computers` lists it (ee/apps/headless-runner/src/computer-fleet.ts). */
export const runnerComputerSchema = z.object({
  id: z.string().min(1).max(200),
  key: fleetText,
  source: z.enum(["gateway", "direct"]),
  provider: z.string().min(1).max(40),
  status: z.string().min(1).max(40),
  statusReason: fleetText,
  pool: fleetText,
  backend: fleetText,
  region: fleetText,
  cpu: fleetCount,
  memoryMb: fleetCount,
  diskGb: fleetCount,
  createdAt: fleetText,
  updatedAt: fleetText,
  startedAt: fleetText,
  pausedAt: fleetText,
  lastActivityAt: fleetText,
  expiresAt: fleetText,
  endedAt: fleetText,
  attempts: fleetCount,
  image: fleetText.default(null),
  imageCurrent: z.boolean().nullable().default(null),
  idleTimeoutSeconds: fleetCount.default(null),
  idledAt: fleetText.default(null),
  resumeRequestedAt: fleetText.default(null),
  slotReleased: z.boolean().nullable().default(null),
  trust: fleetText.default(null),
  runSeconds: fleetCount.default(null),
})
export type RunnerComputer = z.infer<typeof runnerComputerSchema>
/** How the runner treats one source's computers: what new ones are built from, and when it pauses and deletes them. */
export const runnerComputerSettingsSchema = z.object({
  image: fleetText,
  idlePauseSeconds: z.number().finite().nonnegative(),
  keepDays: z.number().finite().nonnegative(),
  persistent: z.boolean(),
})
export type RunnerComputerSettings = z.infer<typeof runnerComputerSettingsSchema>
export const runnerComputerSourceSchema = z.object({
  source: z.enum(["gateway", "direct"]),
  provider: z.string().min(1).max(40),
  status: z.enum(["ok", "unreachable", "unsupported"]),
  error: z.string().max(40).nullable(),
  truncated: z.boolean(),
  pools: z.array(z.object({ name: z.string().max(200), backend: fleetText, region: fleetText, enabled: z.boolean(), health: z.string().max(40) })).max(64),
  settings: runnerComputerSettingsSchema.nullable().default(null),
})
export type RunnerComputerSource = z.infer<typeof runnerComputerSourceSchema>
export const runnerComputerFleetSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().max(40),
  sources: z.array(runnerComputerSourceSchema).max(8),
  sandboxes: z.array(runnerComputerSchema).max(8_000),
})
export type RunnerComputerFleet = z.infer<typeof runnerComputerFleetSchema>
/** One computer in full, as the runner's `GET /v1/computers/:source/:id` returns it. */
export const runnerComputerDetailSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().max(40),
  computer: runnerComputerSchema,
  limits: z.object({
    profile: fleetText,
    classification: fleetText,
    capabilities: z.array(z.string().max(200)).max(100),
    preemptible: z.boolean().nullable(),
    ttlSeconds: fleetCount,
    maxRunSeconds: fleetCount,
    maxPausedSeconds: fleetCount,
    autoDeleteSeconds: fleetCount,
    totalRunSeconds: fleetCount,
  }),
  settings: runnerComputerSettingsSchema.nullable(),
  placement: z.object({
    pool: fleetText,
    strategy: fleetText,
    outcome: fleetText,
    reason: fleetText,
    evaluatedAt: fleetText,
    policies: z.array(z.string().max(200)).max(50),
    candidates: z.array(z.object({
      pool: z.string().max(200),
      trust: fleetText,
      eligible: z.boolean().nullable(),
      hasCapacity: z.boolean().nullable(),
      rank: fleetCount,
      reasons: z.array(z.string().max(2_000)).max(20),
    })).max(50),
  }).nullable(),
  events: z.array(z.object({ at: fleetText, action: z.string().max(200), outcome: fleetText, details: z.record(z.string(), z.string().max(2_000)) })).max(200).nullable(),
  eventsError: z.string().max(40).nullable(),
})
export type RunnerComputerDetail = z.infer<typeof runnerComputerDetailSchema>
const cellIdsSchema = z.object({ ids: z.record(z.string().max(220), z.string().regex(/^[0-9a-f]{16,128}$/)) })
const computerRefusalSchema = z.object({ error: z.string().max(60), code: z.string().max(40).optional() })

const REQUEST_TIMEOUT_MS = 20_000

async function request(deps: HeadlessRunnerDeps, method: string, path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await deps.fetch(`${deps.config.url}${path}`, {
    method,
    headers: runnerHeaders(deps.config, { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload: unknown = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

function errorCode(payload: unknown, fallback: string) {
  const parsed = z.object({ error: z.string() }).safeParse(payload)
  return parsed.success ? parsed.data.error : fallback
}

const sessionPath = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}`

/**
 * How long the session's turns may keep repeating a step (same calls, same results) before the model is asked to
 * stop and report: the same successful answer for `maxWaitingMs` (10 s to 24 h), or the same failure
 * `maxIdenticalFailures` times (2 to 100). Unset values use the runner's defaults.
 */
export type RunnerRepeatLimits = { maxWaitingMs?: number; maxIdenticalFailures?: number }

/**
 * What a conversation may use beyond chat: kept files, a Linux computer, emoji reactions to the person's message,
 * and background tasks it can hand longer work to while it keeps talking. All are off unless asked for (files and
 * the computer must be configured on the runner too), so a caller that never asks (Automations) never gets any of
 * them. Slack asks for reactions and tasks where `slackWorkbotReplies` is on.
 */
export type RunnerCapabilities = {
  files?: boolean
  computer?: boolean
  desktop?: boolean
  desktopViews?: RunnerDesktopView[]
  reactions?: boolean
  tasks?: boolean
  documentNavigation?: boolean
  teachingNavigation?: boolean
  sandboxGateway?: boolean
  browserRecovery?: boolean
}
export const RUNNER_DESKTOP_VIEWS = ["browser", "computer"] as const
export type RunnerDesktopView = (typeof RUNNER_DESKTOP_VIEWS)[number]

/**
 * Who a conversation belongs to and how it is shown to the model: `owner` (the caller's key for one person) and `ref`
 * (the caller's id for the conversation) list a person's conversations; `timeZone` dates their messages; `autoTitle`
 * names it after its first answer; `memoryOf` shares memory/ with another of their conversations (legacy chats);
 * `memoryScope: "owner"` keeps memory/ with the owner, shared by all their chats (per-chat session cells).
 */
export type RunnerSessionSettings = { owner?: string; ref?: string; timeZone?: string; autoTitle?: boolean; memoryOf?: string; memoryScope?: "owner" }

const capabilityFields = (input: RunnerCapabilities & RunnerSessionSettings) => ({
  ...(input.files !== undefined ? { files: input.files } : {}),
  ...(input.computer !== undefined ? { computer: input.computer } : {}),
  ...(input.desktop !== undefined ? { desktop: input.desktop } : {}),
  ...(input.desktopViews ? { desktopViews: input.desktopViews } : {}),
  ...(input.reactions !== undefined ? { reactions: input.reactions } : {}),
  ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
  ...(input.documentNavigation !== undefined ? { documentNavigation: input.documentNavigation } : {}),
  ...(input.teachingNavigation !== undefined ? { teachingNavigation: input.teachingNavigation } : {}),
  ...(input.sandboxGateway !== undefined ? { sandboxGateway: input.sandboxGateway } : {}),
  ...(input.browserRecovery !== undefined ? { browserRecovery: input.browserRecovery } : {}),
  ...(input.owner ? { owner: input.owner } : {}),
  ...(input.ref ? { ref: input.ref } : {}),
  ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
  ...(input.memoryOf ? { memoryOf: input.memoryOf } : {}),
  ...(input.memoryScope ? { memoryScope: input.memoryScope } : {}),
})

const unknownSetting = (status: number, payload: unknown) => status === 400 && errorCode(payload, "invalid_request") === "invalid_request"

const runnerLiveEventSchema = z.looseObject({ type: z.string() })
export type RunnerLiveEvent = z.infer<typeof runnerLiveEventSchema>

type HeaderWebSocket = {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void
}
type HeaderWebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => HeaderWebSocket
function isHeaderWebSocket(value: unknown): value is HeaderWebSocketConstructor {
  return typeof value === "function"
}
const SOCKET_PING = "ping"
const SOCKET_PING_MS = 30_000
const SOCKET_MAX_QUEUED = 10_000

export function createHeadlessRunnerClient(deps: HeadlessRunnerDeps) {
  return {
    async desktopViewer(sessionId: string, input: { view: "browser" | "computer"; control: boolean; origin: string }) {
      const { status, payload } = await request(deps, "POST", `${sessionPath(sessionId)}/desktop/viewer`, input, 180_000)
      const parsed = z.union([z.object({ state: z.literal("paused") }), z.object({ state: z.literal("connected"), url: z.string().url(), expiresAt: z.number(), paused: z.boolean() })]).safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false as const, status, error: errorCode(payload, "desktop_unavailable") }
      return { ok: true as const, value: parsed.data }
    },
    async browserDemonstration(sessionId: string, command: DemonstrationCommand) {
      const { status, payload } = await request(deps, "POST", `${sessionPath(sessionId)}/desktop/demonstration`, command, 180_000)
      const parsed = demonstrationReplySchema.safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false as const, status, error: errorCode(payload, "teaching_unavailable") }
      return { ok: true as const, value: parsed.data }
    },
    async desktopAction(sessionId: string, action: "continue" | "pause" | "resume" | "rebuild") {
      const { status, payload } = await request(deps, "POST", `${sessionPath(sessionId)}/desktop/action`, { action }, 180_000)
      return { ok: status === 200, error: errorCode(payload, "desktop_unavailable") }
    },
    async createSession(
      input: { title?: string; instructions?: string; repeats?: RunnerRepeatLimits; memoryScope?: "owner" } & RunnerCapabilities = {},
    ): Promise<RunnerResult<{ id: string }>> {
      const base = {
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        ...(input.instructions ? { instructions: input.instructions.slice(0, 20_000) } : {}),
      }
      const extras = { ...(input.repeats ? { repeats: input.repeats } : {}), ...capabilityFields(input) }
      let { status, payload } = await request(deps, "POST", "/v1/sessions", { ...base, ...extras })
      if (status === 400 && Object.keys(extras).length) ({ status, payload } = await request(deps, "POST", "/v1/sessions", base))
      const created = z.object({ id: z.string() }).safeParse(payload)
      if (status !== 201 || !created.success) return { ok: false, status, error: errorCode(payload, `headless_create_${status}`) }
      return { ok: true, value: { id: created.data.id } }
    },

    async putSession(
      id: string,
      input: { title?: string; instructions?: string; repeats?: RunnerRepeatLimits } & RunnerCapabilities & RunnerSessionSettings & {
        strict?: boolean
      } = {},
    ): Promise<RunnerResult<{ id: string; created: boolean }>> {
      const base = {
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions.slice(0, 20_000) } : {}),
      }
      const extras = { ...(input.repeats ? { repeats: input.repeats } : {}), ...capabilityFields(input) }
      let { status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...extras })
      let compatible: Record<string, unknown> = extras
      if (unknownSetting(status, payload) && input.teachingNavigation !== undefined) {
        const { teachingNavigation: _teaching, ...rest } = compatible
        compatible = rest
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...compatible }))
      }
      if (unknownSetting(status, payload) && input.browserRecovery !== undefined) {
        const { browserRecovery: _recovery, ...rest } = compatible
        compatible = rest
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...compatible }))
      }
      if (unknownSetting(status, payload) && input.sandboxGateway !== undefined) {
        const { sandboxGateway: _gateway, ...rest } = compatible
        compatible = rest
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...compatible }))
      }
      let limited = false
      if (unknownSetting(status, payload) && input.desktopViews !== undefined) {
        const { desktopViews: _views, ...rest } = compatible
        limited = !RUNNER_DESKTOP_VIEWS.every(view => input.desktopViews!.includes(view))
        compatible = limited ? { ...rest, desktop: false } : rest
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...compatible }))
      }
      if (unknownSetting(status, payload) && input.documentNavigation !== undefined) {
        const { documentNavigation: _navigation, ...rest } = compatible
        compatible = rest
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...compatible }))
      }
      if (unknownSetting(status, payload) && input.desktop === false && !limited) {
        const { desktop: _desktop, ...rest } = compatible
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...rest }))
      }
      if (unknownSetting(status, payload) && Object.keys(extras).length && !input.strict && !limited) ({ status, payload } = await request(deps, "PUT", sessionPath(id), base))
      const saved = z.object({ id: z.string() }).safeParse(payload)
      if ((status !== 200 && status !== 201) || !saved.success) return { ok: false, status, error: errorCode(payload, `headless_put_${status}`) }
      return { ok: true, value: { id: saved.data.id, created: status === 201 } }
    },

    async splitOwner(): Promise<RunnerResult<{ split: string }>> {
      const { status, payload } = await request(deps, "POST", "/v1/owner/split", {})
      if (status === 404 || status === 405) return { ok: true, value: { split: "unsupported" } }
      const parsed = z.object({ split: z.string() }).safeParse(payload)
      if ((status !== 200 && status !== 202) || !parsed.success) return { ok: false, status, error: errorCode(payload, `headless_split_${status}`) }
      return { ok: true, value: parsed.data }
    },

    async listSessions(owner: string, options: { limit?: number } = {}): Promise<RunnerResult<{ sessions: RunnerSessionSummary[] }>> {
      const { status, payload } = await request(deps, "GET", `/v1/sessions?owner=${encodeURIComponent(owner)}&limit=${options.limit ?? 50}`)
      const parsed = z.object({ sessions: z.array(runnerSessionSummarySchema) }).safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false, status, error: errorCode(payload, `headless_list_${status}`) }
      return { ok: true, value: parsed.data }
    },

    async deleteSession(id: string): Promise<RunnerResult<{ deleted: true }>> {
      const { status, payload } = await request(deps, "DELETE", sessionPath(id))
      if (status !== 204) return { ok: false, status, error: errorCode(payload, `headless_delete_${status}`) }
      return { ok: true, value: { deleted: true } }
    },

    async deleteComputer(id: string): Promise<RunnerResult<{ deleted: true }>> {
      const { status, payload } = await request(deps, "DELETE", `${sessionPath(id)}/computer`, undefined, 60_000)
      if (status !== 204) return { ok: false, status, error: errorCode(payload, `headless_computer_delete_${status}`) }
      return { ok: true, value: { deleted: true } }
    },

    async listScratchFiles(sessionId: string): Promise<RunnerResult<Array<{ path: string; size: number; updatedAt: number }>>> {
      const { status, payload } = await request(deps, "GET", `${sessionPath(sessionId)}/files`)
      const parsed = z.object({ files: z.array(z.object({ path: z.string(), size: z.number(), updatedAt: z.number() })) }).safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false, status, error: errorCode(payload, `headless_scratch_${status}`) }
      return { ok: true, value: parsed.data.files }
    },

    async readFile(sessionId: string, path: string): Promise<RunnerResult<{ content: string }>> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/files/content?path=${encodeURIComponent(path)}`, {
        headers: runnerHeaders(deps.config),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.status !== 200) return { ok: false, status: response.status, error: `headless_file_${response.status}` }
      return { ok: true, value: { content: await response.text() } }
    },

    async sendTurn(
      actor: HeadlessRunnerActor,
      input: {
        sessionId: string
        messageId: string
        prompt: string
        model?: string
        modelAccessRequired?: boolean
        ttlMs?: number
        attachments?: string[]
        readOnly?: boolean
        mcpReadOnly?: boolean
        mcpScopes?: readonly string[]
        interrupt?: boolean
        execution?: "steps"
      },
    ): Promise<RunnerResult<{ state: string }>> {
      const ttlMs = Math.min(input.ttlMs ?? deps.maxTokenTtlMs, deps.maxTokenTtlMs)
      let modelAccessRequired = input.modelAccessRequired === true
      const mint = async (model?: string) => {
        const issued = await deps.mintToken({
          ...actor,
          ttlMs,
          sessionId: input.sessionId,
          messageId: input.messageId,
          ...(model ? { model } : {}),
          ...(modelAccessRequired ? { modelAccessRequired: true } : {}),
          ...(input.readOnly || input.mcpReadOnly ? { readOnly: true } : {}),
          ...((input.readOnly || input.mcpReadOnly) && input.mcpScopes?.length ? { scopes: input.mcpScopes } : {}),
        })
        const modelAccess = issued.modelAccess ?? await deps.modelAccess?.(actor, { ...(model ? { model } : {}), ...(modelAccessRequired ? { modelAccessRequired: true } : {}) })
        return { ...issued, modelAccess }
      }
      const persistedModel = async (): Promise<RunnerResult<{ model?: string; modelAccessRequired?: boolean }>> => {
        const query = new URLSearchParams({ messageId: input.messageId, limit: "1", outputs: "none" })
        let read: Awaited<ReturnType<typeof request>>
        try {
          read = await request(deps, "GET", `${sessionPath(input.sessionId)}?${query.toString()}`)
        } catch {
          return { ok: false, status: 503, error: "headless_read_unavailable" }
        }
        if (read.status === 404) return { ok: true, value: {} }
        if (read.status !== 200) return { ok: false, status: read.status, error: errorCode(read.payload, `headless_read_${read.status}`) }
        const snapshot = runnerSnapshotSchema.safeParse(read.payload)
        if (!snapshot.success) return { ok: false, status: read.status, error: "headless_read_invalid" }
        const existing = snapshot.data.turns.find((turn) => turn.messageId === input.messageId)
        if (existing && !existing.model) return { ok: false, status: 409, error: "headless_saved_model_unavailable" }
        return { ok: true, value: { ...(existing?.model ? { model: existing.model } : {}), ...(existing?.modelAccessRequired ? { modelAccessRequired: true } : {}) } }
      }
      const required = modelAccessRequired || (await deps.modelAccessRequired?.(actor) ?? false)
      let model = input.model
      if (required) {
        const original = await persistedModel()
        if (!original.ok) return original
        model = original.value.model ?? model
        modelAccessRequired ||= original.value.modelAccessRequired === true
      }
      let issued = await mint(model)
      if (required && !issued.modelAccess) return { ok: false, status: 503, error: "headless_model_access_unavailable" }
      if (!required && issued.modelAccess) {
        const original = await persistedModel()
        if (!original.ok) return original
        if ((original.value.model && original.value.model !== model) || (!modelAccessRequired && original.value.modelAccessRequired)) {
          model = original.value.model ?? model
          modelAccessRequired ||= original.value.modelAccessRequired === true
          issued = await mint(model)
          if (!issued.modelAccess) return { ok: false, status: 503, error: "headless_model_access_unavailable" }
        }
      }
      const { token, resumeGrant, modelAccess, indexCapability } = issued
      const { status, payload } = await request(deps, "POST", `${sessionPath(input.sessionId)}/turns`, {
        messageId: input.messageId,
        prompt: input.prompt,
        ...(model ? { model } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(input.interrupt ? { interrupt: true } : {}),
        ...(input.execution === "steps" ? { execution: "steps" } : {}),
        credentials: {
          mcpToken: token,
          ...(input.readOnly ? { readOnly: true } : {}),
          ...(resumeGrant ? { resumeGrant } : {}),
          ...(modelAccess ? { modelAccess } : {}),
          ...(indexCapability ? { indexCapability } : {}),
        },
      })
      if (status !== 202) return { ok: false, status, error: errorCode(payload, `headless_send_${status}`) }
      const accepted = z.object({ state: z.string() }).safeParse(payload)
      return { ok: true, value: { state: accepted.success ? accepted.data.state : "accepted" } }
    },

    async readSession(
      sessionId: string,
      input: { messageId?: string; limit?: number; outputs?: "none"; turns?: number; before?: string; expectedOwner?: string } = {},
    ): Promise<RunnerResult<RunnerSnapshot>> {
      const query = new URLSearchParams({ limit: String(input.limit ?? 500) })
      if (input.messageId) query.set("messageId", input.messageId)
      if (input.outputs) query.set("outputs", input.outputs)
      if (input.turns) query.set("turns", String(input.turns))
      if (input.before) query.set("before", input.before)
      if (input.expectedOwner !== undefined) query.set("expectedOwner", input.expectedOwner)
      const { status, payload } = await request(deps, "GET", `${sessionPath(sessionId)}?${query.toString()}`)
      if (status !== 200) return { ok: false, status, error: errorCode(payload, `headless_read_${status}`) }
      const snapshot = runnerSnapshotSchema.safeParse(payload)
      if (!snapshot.success) return { ok: false, status, error: "headless_read_invalid" }
      return {
        ok: true,
        value: {
          turns: snapshot.data.turns,
          finalAssistantText: snapshot.data.finalAssistantText,
          status: snapshot.data.status,
          hasEarlier: snapshot.data.hasEarlier,
          messages: snapshot.data.messages.flatMap((entry) => {
            const parsed = runnerMessageSchema.safeParse(entry)
            return parsed.success ? [parsed.data] : []
          }),
        },
      }
    },

    async filesEnabled(): Promise<boolean> {
      try {
        const { status, payload } = await request(deps, "GET", "/v1/files/status")
        const parsed = z.object({ enabled: z.boolean() }).safeParse(payload)
        return status === 200 && parsed.success && parsed.data.enabled
      } catch {
        return false
      }
    },

    async uploadFile(sessionId: string, input: { name: string; mediaType: string; bytes: ArrayBuffer }): Promise<RunnerResult<RunnerSavedFile>> {
      const query = new URLSearchParams({ name: input.name })
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/saved-files?${query.toString()}`, {
        method: "POST",
        headers: runnerHeaders(deps.config, { "content-type": input.mediaType || "application/octet-stream" }),
        body: input.bytes,
        signal: AbortSignal.timeout(10 * 60_000),
      })
      const payload: unknown = await response.json().catch(() => ({}))
      const file = runnerSavedFileSchema.safeParse(payload)
      if (response.status !== 201 || !file.success) return { ok: false, status: response.status, error: errorCode(payload, `headless_upload_${response.status}`) }
      return { ok: true, value: file.data }
    },

    async listFiles(sessionId: string): Promise<RunnerResult<RunnerSavedFile[]>> {
      const { status, payload } = await request(deps, "GET", `${sessionPath(sessionId)}/saved-files`)
      const parsed = z.object({ files: z.array(runnerSavedFileSchema) }).safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false, status, error: errorCode(payload, `headless_files_${status}`) }
      return { ok: true, value: parsed.data.files }
    },

    async downloadFile(sessionId: string, fileId: string): Promise<Response | null> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/saved-files/${encodeURIComponent(fileId)}`, {
        headers: runnerHeaders(deps.config),
        signal: AbortSignal.timeout(10 * 60_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      return response
    },

    async previewManifest(sessionId: string, fileId: string): Promise<{ pages: number; width: number; height: number } | null> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/saved-files/${encodeURIComponent(fileId)}/preview`, {
        headers: runnerHeaders(deps.config),
        signal: AbortSignal.timeout(3 * 60_000),
      })
      const payload: unknown = await response.json().catch(() => null)
      const parsed = z.object({ pages: z.number().int().min(1), width: z.number().int().min(1), height: z.number().int().min(1) }).safeParse(payload)
      return response.ok && parsed.success ? parsed.data : null
    },

    async previewPage(sessionId: string, fileId: string, page: number): Promise<Response | null> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/saved-files/${encodeURIComponent(fileId)}/preview/${page}`, {
        headers: runnerHeaders(deps.config),
        signal: AbortSignal.timeout(60_000),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      return response
    },

    async deleteFile(sessionId: string, fileId: string): Promise<boolean> {
      const { status } = await request(deps, "DELETE", `${sessionPath(sessionId)}/saved-files/${encodeURIComponent(fileId)}`)
      return status === 204
    },

    async openEvents(sessionId: string, signal: AbortSignal): Promise<Response | null> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/events`, {
        headers: runnerHeaders(deps.config, { accept: "text/event-stream" }),
        signal,
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      return response
    },

    async openEventsSocket(sessionId: string, signal: AbortSignal): Promise<AsyncIterableIterator<RunnerLiveEvent> | null> {
      const Socket: unknown = Reflect.get(globalThis, "WebSocket")
      if (!isHeaderWebSocket(Socket) || signal.aborted) return null
      const url = new URL(`${deps.config.url}${sessionPath(sessionId)}/events`)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      let socket: HeaderWebSocket
      try {
        socket = new Socket(url.toString(), { headers: runnerHeaders(deps.config) })
      } catch {
        return null
      }
      const queue: RunnerLiveEvent[] = []
      let ended = false
      let wake: (() => void) | null = null
      let ping: ReturnType<typeof setInterval> | undefined
      let settle: (opened: boolean) => void = () => undefined
      const end = () => {
        settle(false)
        if (!ended) {
          ended = true
          clearInterval(ping)
          signal.removeEventListener("abort", end)
          try {
            socket.close(1000)
          } catch {
          }
        }
        const resume = wake
        wake = null
        resume?.()
      }
      signal.addEventListener("abort", end, { once: true })
      socket.addEventListener("message", (message) => {
        if (ended || typeof message.data !== "string") return
        let raw: unknown
        try {
          raw = JSON.parse(message.data)
        } catch {
          return
        }
        const event = runnerLiveEventSchema.safeParse(raw)
        if (!event.success) return
        queue.push(event.data)
        if (queue.length > SOCKET_MAX_QUEUED) return end()
        const resume = wake
        wake = null
        resume?.()
      })
      socket.addEventListener("error", end)
      socket.addEventListener("close", end)
      const opened = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(end, REQUEST_TIMEOUT_MS)
        settle = (value) => {
          clearTimeout(timer)
          settle = () => undefined
          resolve(value)
        }
        socket.addEventListener("open", () => settle(!ended))
      })
      if (!opened) {
        end()
        return null
      }
      ping = setInterval(() => {
        try {
          socket.send(SOCKET_PING)
        } catch {
          end()
        }
      }, SOCKET_PING_MS)
      async function* events(): AsyncGenerator<RunnerLiveEvent> {
        try {
          for (;;) {
            const next = queue.shift()
            if (next) {
              yield next
              continue
            }
            if (ended) return
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
        } finally {
          end()
        }
      }
      return events()
    },

    async deleteTurns(sessionId: string, messageId: string, options: { andAfter?: boolean } = {}): Promise<RunnerResult<{ removed: string[] }>> {
      const { status, payload } = await request(deps, "DELETE", `${sessionPath(sessionId)}/turns/${encodeURIComponent(messageId)}${options.andAfter ? "?after=1" : ""}`)
      const parsed = z.object({ removed: z.array(z.string()) }).safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false, status, error: errorCode(payload, "runner_unavailable") }
      return { ok: true, value: parsed.data }
    },

    async abort(sessionId: string, messageId?: string): Promise<{ reached: boolean; stopped: boolean }> {
      const { status, payload } = await request(deps, "POST", `${sessionPath(sessionId)}/abort`, messageId ? { messageId } : {})
      const parsed = z.object({ accepted: z.boolean() }).safeParse(payload)
      return { reached: status === 200, stopped: status === 200 && parsed.success && parsed.data.accepted }
    },

    async testModel(model: string, modelAccess?: HeadlessModelAccess): Promise<HeadlessModelProbe | null> {
      const { status, payload } = await request(deps, "POST", "/v1/model-probe", { model, ...(modelAccess ? { modelAccess } : {}) })
      const result = modelProbeSchema.safeParse(payload)
      if (status !== 200 || !result.success || result.data.requestedModel !== model) return null
      return result.data
    },

    async cellIds(names: readonly string[]): Promise<RunnerResult<Record<string, string>>> {
      let answer: Awaited<ReturnType<typeof request>>
      try {
        answer = await request(deps, "POST", "/v1/cells/ids", { names }, COMPUTERS_TIMEOUT_MS)
      } catch (error) {
        return { ok: false, status: 503, error: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "unreachable" }
      }
      if (answer.status !== 200) return { ok: false, status: answer.status, error: `http_${answer.status}` }
      const parsed = cellIdsSchema.safeParse(answer.payload)
      return parsed.success ? { ok: true, value: parsed.data.ids } : { ok: false, status: 502, error: "invalid_response" }
    },

    async listComputers(): Promise<RunnerResult<RunnerComputerFleet>> {
      let answer: Awaited<ReturnType<typeof request>>
      try {
        answer = await request(deps, "GET", "/v1/computers", undefined, COMPUTERS_TIMEOUT_MS)
      } catch (error) {
        return { ok: false, status: 503, error: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "unreachable" }
      }
      if (answer.status !== 200) return { ok: false, status: answer.status, error: `http_${answer.status}` }
      const parsed = runnerComputerFleetSchema.safeParse(answer.payload)
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, status: 502, error: "invalid_response" }
    },

    async readComputer(source: "gateway" | "direct", id: string): Promise<RunnerResult<RunnerComputerDetail>> {
      let answer: Awaited<ReturnType<typeof request>>
      try {
        answer = await request(deps, "GET", `/v1/computers/${source}/${encodeURIComponent(id)}`, undefined, COMPUTERS_TIMEOUT_MS)
      } catch (error) {
        return { ok: false, status: 503, error: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError") ? "timeout" : "unreachable" }
      }
      if (answer.status !== 200) {
        const refusal = computerRefusalSchema.safeParse(answer.payload)
        const named = refusal.success && (refusal.data.error === "unknown_computer" || refusal.data.error === "invalid_computer") ? refusal.data.error : null
        const provider = refusal.success && refusal.data.error === "provider_unreachable" ? `provider_${refusal.data.code ?? "unreachable"}` : null
        return { ok: false, status: answer.status, error: named ?? provider ?? `http_${answer.status}` }
      }
      const parsed = runnerComputerDetailSchema.safeParse(answer.payload)
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, status: 502, error: "invalid_response" }
    },

    async listModels(modelAccess?: HeadlessModelAccess): Promise<HeadlessModelCatalog | null> {
      try {
        const { status, payload } = modelAccess
          ? await request(deps, "POST", "/v1/models", { modelAccess })
          : await request(deps, "GET", "/v1/models")
        const parsed = modelCatalogSchema.safeParse(payload)
        return status === 200 && parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
  }
}

export type HeadlessRunnerClient = ReturnType<typeof createHeadlessRunnerClient>
