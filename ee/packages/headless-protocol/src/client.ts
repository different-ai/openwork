import { z } from "zod"
import { demonstrationReplySchema, type DemonstrationCommand } from "@openwork/types/browser-demonstration"

/**
 * The typed client for the headless runner (ee/apps/headless-runner): the one place that knows its routes,
 * response shapes and live events.
 *
 * Slack replies, cloud Automations and Workbot all run agent turns there. Each surface authorizes the member
 * first; the client then mints a short-lived, member-scoped OpenWork MCP token for every turn it sends (through the
 * caller's `mintToken`), so the runner can only reach what that member can reach, and only for the life of the turn.
 */
/**
 * `owner` routes every call to one owner's cell on a cell runtime (ee/apps/headless-runner/OWNER-CELLS.md). The
 * Node runner ignores it. Only a trusted service sets it, from the person it already authenticated.
 */
export type HeadlessRunnerConfig = { url: string; token: string; owner?: string }

export const HEADLESS_OWNER_HEADER = "x-openwork-headless-owner"

function runnerHeaders(config: HeadlessRunnerConfig, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${config.token}`, ...(config.owner ? { [HEADLESS_OWNER_HEADER]: config.owner } : {}), ...extra }
}

function isSafeRunnerUrl(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol === "https:") return true
    // Render private services and local development use plain http on an internal network.
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

/** Drops trailing slashes in one pass (a regex like /\/+$/ can backtrack badly on a long run of slashes). */
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
  /** Trusted route's upstream identity. The persisted selection still pins its free/paid access domain. */
  model: z.string().trim().min(1).max(512).optional(),
})
export type HeadlessModelAccess = z.infer<typeof headlessModelAccessSchema>

export type HeadlessRunnerActor = { userId: string; organizationId: string }

export type HeadlessRunnerDeps = {
  config: HeadlessRunnerConfig
  fetch: typeof fetch
  /**
   * `sessionId` and `messageId` are the turn the token is minted for, so a caller can remember which run it belongs
   * to. `resumeGrant` (saved step turns): a credential the runner can exchange with Den for a fresh token
   * for this turn, so it can continue the turn on its own after a restart. `indexCapability`: what the runner presents
   * to report the session's content-free totals and state to Den's session index.
   */
  mintToken: (
    input: HeadlessRunnerActor & { ttlMs?: number; sessionId?: string; messageId?: string; readOnly?: boolean; model?: string; modelAccessRequired?: boolean },
  ) => Promise<{ token: string; resumeGrant?: string; modelAccess?: HeadlessModelAccess; indexCapability?: string }>
  /** Resolve scoped turns' persisted model before minting, even when today's default is no longer accessible. */
  modelAccessRequired?: (actor: HeadlessRunnerActor) => Promise<boolean> | boolean
  /** Optional trusted caller hook for member-scoped turns when mintToken does not supply access. */
  modelAccess?: (actor: HeadlessRunnerActor, selection?: { model?: string; modelAccessRequired?: boolean }) => Promise<HeadlessModelAccess | undefined>
  /** The longest a minted MCP token may live; a turn asking for longer gets this. */
  maxTokenTtlMs: number
}

/** queued | running | completed | failed | interrupted | aborted; kept open so a new runner status never breaks reads. */
export type RunnerTurnStatus = string

export const runnerTurnSchema = z.object({
  messageId: z.string(),
  status: z.string(),
  model: z.string().nullable().optional(),
  /** Nonsecret durable policy; retains scoped recovery when the current rollout is off. */
  modelAccessRequired: z.boolean().optional(),
  error: z.string().nullable(),
  usage: z.object({ inputTokens: z.number(), cachedInputTokens: z.number(), outputTokens: z.number() }).optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  /**
   * `task` for a background task (`parent` is the turn that started it, `title` its name), `report` for the turn that
   * brings a finished task back to the conversation (`parent` is the task). Absent for turns a caller sent. Kept open
   * like `status`.
   */
  kind: z.string().optional(),
  parent: z.string().optional(),
  title: z.string().optional(),
  /** What the model provider said when the turn failed, for logs and support; never shown to the person as is. */
  errorDetail: z.string().optional(),
  /**
   * What a caller-sent turn with no transcript yet was sent with: a message waiting behind the answer in progress, or
   * stopped before it started. Older runners omit it.
   */
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
  /**
   * Reading one turn (`messageId`): that turn, the background tasks it started and their reports. Otherwise the
   * newest turns (a window; see `hasEarlier`), oldest first.
   */
  turns: RunnerTurn[]
  /** Transcript entries the runner returned that Den understands; unknown shapes are skipped. */
  messages: RunnerMessage[]
  /** What the assistant wrote in the turn read (`messageId`), or in the newest turn of the window. */
  finalAssistantText: string
  /** `busy` when the conversation (not a background task) is queued or running, including turns outside the window. */
  status?: string
  /**
   * Set on reads without `messageId`: whether older turns exist, read by passing the first turn's messageId as
   * `before`. Older runners only set it when `turns` was given.
   */
  hasEarlier?: boolean
}

export const ACTIVE_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["queued", "running"])
export const TERMINAL_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["completed", "failed", "aborted"])

const modelCatalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string(), provider: z.string().optional() })),
  /** True only after the configured gateway accepted the runner's model key. Older runners cannot prove readiness. */
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
  /** When its bytes last changed (Workbot revised it in place); missing from older runners. */
  updatedAt: z.number().optional(),
})
export type RunnerSavedFile = z.infer<typeof runnerSavedFileSchema>

export type RunnerResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

const REQUEST_TIMEOUT_MS = 15_000

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
export type RunnerCapabilities = { files?: boolean; computer?: boolean; desktop?: boolean; reactions?: boolean; tasks?: boolean; documentNavigation?: boolean }

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
  ...(input.reactions !== undefined ? { reactions: input.reactions } : {}),
  ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
  ...(input.documentNavigation !== undefined ? { documentNavigation: input.documentNavigation } : {}),
  ...(input.owner ? { owner: input.owner } : {}),
  ...(input.ref ? { ref: input.ref } : {}),
  ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
  ...(input.memoryOf ? { memoryOf: input.memoryOf } : {}),
  ...(input.memoryScope ? { memoryScope: input.memoryScope } : {}),
})

/** A runner older than a setting refuses it as an invalid request; any other refusal is real. */
const unknownSetting = (status: number, payload: unknown) => status === 400 && errorCode(payload, "invalid_request") === "invalid_request"

/**
 * One live event, exactly as the SSE stream's `data:` lines carry it: `ready` first on a socket, then `changed`,
 * `text` and `tool`. Kept open (like turn statuses) so a new event type never breaks a reader; callers validate.
 */
const runnerLiveEventSchema = z.looseObject({ type: z.string() })
export type RunnerLiveEvent = z.infer<typeof runnerLiveEventSchema>

/** What `openEventsSocket` needs of a WebSocket: Node's built-in one (undici) takes request headers, so the token and owner never go in the URL. */
type HeaderWebSocket = {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void
}
type HeaderWebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => HeaderWebSocket
function isHeaderWebSocket(value: unknown): value is HeaderWebSocketConstructor {
  return typeof value === "function"
}
/** The keep-alive a live-event socket sends; the runner's cell answers it without waking. */
const SOCKET_PING = "ping"
const SOCKET_PING_MS = 30_000
/** A reader this far behind is dropped (the socket closes; the caller reconnects and re-reads). */
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
      // A runner older than these settings rejects them: create the session with its defaults.
      if (status === 400 && Object.keys(extras).length) ({ status, payload } = await request(deps, "POST", "/v1/sessions", base))
      const created = z.object({ id: z.string() }).safeParse(payload)
      if (status !== 201 || !created.success) return { ok: false, status, error: errorCode(payload, `headless_create_${status}`) }
      return { ok: true, value: { id: created.data.id } }
    },

    /**
     * Creates the session under a caller-chosen id (`hs_…`), or updates its
     * title and instructions. One durable conversation per person needs no
     * Den-side mapping: the caller derives the id.
     */
    async putSession(
      id: string,
      input: { title?: string; instructions?: string; repeats?: RunnerRepeatLimits } & RunnerCapabilities & RunnerSessionSettings & {
        /**
         * Fail rather than keep the conversation without settings an older runner doesn't know. For a conversation
         * that can only be found again through them (a side chat is listed by `owner` and `ref`).
         */
        strict?: boolean
      } = {},
    ): Promise<RunnerResult<{ id: string; created: boolean }>> {
      const base = {
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions.slice(0, 20_000) } : {}),
      }
      const extras = { ...(input.repeats ? { repeats: input.repeats } : {}), ...capabilityFields(input) }
      let { status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...extras })
      // An older runner has no document-navigation setting: the conversation keeps its other settings and offers links.
      let compatible: Record<string, unknown> = extras
      if (unknownSetting(status, payload) && input.documentNavigation !== undefined) {
        const { documentNavigation: _navigation, ...rest } = compatible
        compatible = rest
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...compatible }))
      }
      // An older runner has no desktop setting. Omitting an explicit off value preserves side-chat settings.
      if (unknownSetting(status, payload) && input.desktop === false) {
        const { desktop: _desktop, ...rest } = compatible
        ;({ status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...rest }))
      }
      // A runner older than per-session capabilities or settings rejects them: keep the conversation, without them.
      if (unknownSetting(status, payload) && Object.keys(extras).length && !input.strict) ({ status, payload } = await request(deps, "PUT", sessionPath(id), base))
      const saved = z.object({ id: z.string() }).safeParse(payload)
      if ((status !== 200 && status !== 201) || !saved.success) return { ok: false, status, error: errorCode(payload, `headless_put_${status}`) }
      return { ok: true, value: { id: saved.data.id, created: status === 201 } }
    },

    /**
     * Asks the runner to move this owner's older conversations into their own session cells, in the background
     * (per-chat session cells). Owner-scoped: needs the client's `owner`. Idempotent; `not_needed` on a runner without
     * cells. A runner from before session cells answers 404: reported as `unsupported`, never an error.
     */
    async splitOwner(): Promise<RunnerResult<{ split: string }>> {
      const { status, payload } = await request(deps, "POST", "/v1/owner/split", {})
      if (status === 404 || status === 405) return { ok: true, value: { split: "unsupported" } }
      const parsed = z.object({ split: z.string() }).safeParse(payload)
      if ((status !== 200 && status !== 202) || !parsed.success) return { ok: false, status, error: errorCode(payload, `headless_split_${status}`) }
      return { ok: true, value: parsed.data }
    },

    /** One owner's conversations that have messages, most recently used first. */
    async listSessions(owner: string, options: { limit?: number } = {}): Promise<RunnerResult<{ sessions: RunnerSessionSummary[] }>> {
      const { status, payload } = await request(deps, "GET", `/v1/sessions?owner=${encodeURIComponent(owner)}&limit=${options.limit ?? 50}`)
      const parsed = z.object({ sessions: z.array(runnerSessionSummarySchema) }).safeParse(payload)
      if (status !== 200 || !parsed.success) return { ok: false, status, error: errorCode(payload, `headless_list_${status}`) }
      return { ok: true, value: parsed.data }
    },

    /** Deletes a conversation with its transcript, files and computer. Fails with `session_busy` (409) while it answers. */
    async deleteSession(id: string): Promise<RunnerResult<{ deleted: true }>> {
      const { status, payload } = await request(deps, "DELETE", sessionPath(id))
      if (status !== 204) return { ok: false, status, error: errorCode(payload, `headless_delete_${status}`) }
      return { ok: true, value: { deleted: true } }
    },

    /** Reads one scratch file the agent wrote in the session. */
    async readFile(sessionId: string, path: string): Promise<RunnerResult<{ content: string }>> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/files/content?path=${encodeURIComponent(path)}`, {
        headers: runnerHeaders(deps.config),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.status !== 200) return { ok: false, status: response.status, error: `headless_file_${response.status}` }
      return { ok: true, value: { content: await response.text() } }
    },

    /**
     * Sends one turn with a fresh member-scoped MCP token. Re-sending the same
     * messageId never starts a second turn; it resumes an interrupted one.
     * `interrupt`: the conversation's answer in progress wraps up at its next safe point instead of this waiting behind
     * it (runners from before it refuse the field, so callers send it only where it is turned on).
     * `execution: "steps"` (saved step turns): the runner runs the turn one step at a time, so a runner deploy
     * switches between steps instead of cutting one off. Sent only when given; older runners refuse the field.
     */
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
        /**
         * A read-scoped MCP token (`mcp:read`) while the session keeps its own file tools, so a background agent can
         * keep notes in `memory/` but can't change anything through MCP. `readOnly` also removes the file tools.
         */
        mcpReadOnly?: boolean
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
        })
        const modelAccess = issued.modelAccess ?? await deps.modelAccess?.(actor, { ...(model ? { model } : {}), ...(modelAccessRequired ? { modelAccessRequired: true } : {}) })
        return { ...issued, modelAccess }
      }
      const persistedModel = async (): Promise<RunnerResult<{ model?: string; modelAccessRequired?: boolean }>> => {
        // A retry's route belongs to its persisted selection, not today's organization default.
        const query = new URLSearchParams({ messageId: input.messageId, limit: "1", outputs: "none" })
        let read: Awaited<ReturnType<typeof request>>
        try {
          read = await request(deps, "GET", `${sessionPath(input.sessionId)}?${query.toString()}`)
        } catch {
          return { ok: false, status: 503, error: "headless_read_unavailable" }
        }
        // Let the ordinary send handle a missing session. An unavailable or malformed snapshot is never a fallback.
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
        // This must precede minting: a changed default may now be unauthorized or use an entirely different protocol.
        const original = await persistedModel()
        if (!original.ok) return original
        model = original.value.model ?? model
        modelAccessRequired ||= original.value.modelAccessRequired === true
      }
      let issued = await mint(model)
      if (required && !issued.modelAccess) return { ok: false, status: 503, error: "headless_model_access_unavailable" }
      if (!required && issued.modelAccess) {
        // Older trusted callers that supply scoped access without the hook still get retry pinning. Legacy sends
        // without scoped access retain their original single-request behavior.
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
        // A grant is minted for named turns, an index capability only where the session is known;
        // without them the body is exactly as before.
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

    /**
     * Every read is bounded. With `messageId`: that turn's transcript (its newest `limit` messages) and the turn with
     * its background tasks and their reports. Without it: the newest `turns` turns (30 unless given, at most 200)
     * before `before`, with their newest `limit` messages; `hasEarlier` says whether to page back.
     * `outputs: "none"` leaves tool outputs on the runner when a caller only needs each tool's outcome.
     */
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

    /** Whether the runner keeps files (a blob store is configured). */
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

    /** The file's bytes as the runner's response, to stream to the browser. */
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

    /** A file's preview (slides, documents): how many page images it has and their size; null when none. */
    async previewManifest(sessionId: string, fileId: string): Promise<{ pages: number; width: number; height: number } | null> {
      const response = await deps.fetch(`${deps.config.url}${sessionPath(sessionId)}/saved-files/${encodeURIComponent(fileId)}/preview`, {
        headers: runnerHeaders(deps.config),
        // Rendering an older file on first open can take a while.
        signal: AbortSignal.timeout(3 * 60_000),
      })
      const payload: unknown = await response.json().catch(() => null)
      const parsed = z.object({ pages: z.number().int().min(1), width: z.number().int().min(1), height: z.number().int().min(1) }).safeParse(payload)
      return response.ok && parsed.success ? parsed.data : null
    },

    /** One preview page as the runner's PNG response, to stream to the browser. */
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

    /**
     * The session's live events (server-sent events: `changed` and `text`), open until `signal` aborts.
     * No request timeout: the stream is meant to stay open while someone watches.
     */
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

    /**
     * The session's live events over a WebSocket (saved step turns): on celld the socket is hibernatable,
     * so it keeps going while the runner's code is switched under it, and doesn't hold up that switch. Yields
     * `{ type: "ready" }`, then each event as `openEvents` carries it, until the socket closes or `signal` aborts.
     * Null when the runner doesn't upgrade (the Node runner, an older runner) or the socket can't open: use
     * `openEvents` then. The token and owner go in request headers, never in the URL.
     */
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
            // Already closed.
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
          // A keep-alive answer, or anything else that isn't an event.
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

    /**
     * Stops one turn, or without a messageId everything running or queued in
     * the session. `reached` is the runner answering; `stopped` is whether
     * anything was still running or queued to stop.
     */
    /**
     * Removes a message and what it led to; `andAfter` removes every later message too (editing replays from there).
     * Fails with `turn_busy` (409) while one of them is still queued or running.
     */
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

    /** A bounded synthetic completion using scoped access when provided, otherwise the deployment key. Never mints an MCP token. */
    async testModel(model: string, modelAccess?: HeadlessModelAccess): Promise<HeadlessModelProbe | null> {
      const { status, payload } = await request(deps, "POST", "/v1/model-probe", { model, ...(modelAccess ? { modelAccess } : {}) })
      const result = modelProbeSchema.safeParse(payload)
      if (status !== 200 || !result.success || result.data.requestedModel !== model) return null
      return result.data
    },

    /** Scoped catalogs use an authenticated POST; legacy deployment catalogs keep the existing GET. */
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
