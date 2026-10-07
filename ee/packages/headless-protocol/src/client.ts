import { z } from "zod"

/**
 * The typed client for the headless runner (ee/apps/headless-runner): the one place that knows its routes,
 * response shapes and live events.
 *
 * Slack replies, cloud Automations and Workbot all run agent turns there. Each surface authorizes the member
 * first; the client then mints a short-lived, member-scoped OpenWork MCP token for every turn it sends (through the
 * caller's `mintToken`), so the runner can only reach what that member can reach, and only for the life of the turn.
 */
export type HeadlessRunnerConfig = { url: string; token: string }

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

export type HeadlessRunnerActor = { userId: string; organizationId: string }

export type HeadlessRunnerDeps = {
  config: HeadlessRunnerConfig
  fetch: typeof fetch
  /** `messageId` is the turn the token is minted for, so a caller can remember which run it belongs to. */
  mintToken: (input: HeadlessRunnerActor & { ttlMs?: number; messageId?: string; readOnly?: boolean }) => Promise<{ token: string }>
  /** The longest a minted MCP token may live; a turn asking for longer gets this. */
  maxTokenTtlMs: number
}

/** queued | running | completed | failed | interrupted | aborted; kept open so a new runner status never breaks reads. */
export type RunnerTurnStatus = string

export const runnerTurnSchema = z.object({
  messageId: z.string(),
  status: z.string(),
  model: z.string().nullable().optional(),
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
  turns: RunnerTurn[]
  /** Transcript entries the runner returned that Den understands; unknown shapes are skipped. */
  messages: RunnerMessage[]
  finalAssistantText: string
  /** `busy` when any turn in the session is queued or running, including turns outside a windowed read. */
  status?: string
  /** Set on windowed reads (`turns`): whether older turns exist. */
  hasEarlier?: boolean
}

export const ACTIVE_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["queued", "running"])
export const TERMINAL_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["completed", "failed", "aborted"])

const modelCatalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type HeadlessModelCatalog = z.infer<typeof modelCatalogSchema>

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

async function request(deps: HeadlessRunnerDeps, method: string, path: string, body?: unknown) {
  const response = await deps.fetch(`${deps.config.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${deps.config.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
 * the computer must be configured on the runner too), so a caller that never asks (Slack, Automations) never gets
 * any of them.
 */
export type RunnerCapabilities = { files?: boolean; computer?: boolean; reactions?: boolean; tasks?: boolean }

/**
 * Who a conversation belongs to and how it is shown to the model: `owner` (the caller's key for one person) and `ref`
 * (the caller's id for the conversation) list a person's conversations; `timeZone` dates their messages; `autoTitle`
 * names it after its first answer; `memoryOf` shares memory/ with another of their conversations.
 */
export type RunnerSessionSettings = { owner?: string; ref?: string; timeZone?: string; autoTitle?: boolean; memoryOf?: string }

const capabilityFields = (input: RunnerCapabilities & RunnerSessionSettings) => ({
  ...(input.files !== undefined ? { files: input.files } : {}),
  ...(input.computer !== undefined ? { computer: input.computer } : {}),
  ...(input.reactions !== undefined ? { reactions: input.reactions } : {}),
  ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
  ...(input.owner ? { owner: input.owner } : {}),
  ...(input.ref ? { ref: input.ref } : {}),
  ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  ...(input.autoTitle !== undefined ? { autoTitle: input.autoTitle } : {}),
  ...(input.memoryOf ? { memoryOf: input.memoryOf } : {}),
})

/** A runner older than a setting refuses it as an invalid request; any other refusal is real. */
const unknownSetting = (status: number, payload: unknown) => status === 400 && errorCode(payload, "invalid_request") === "invalid_request"

export function createHeadlessRunnerClient(deps: HeadlessRunnerDeps) {
  return {
    async createSession(
      input: { title?: string; instructions?: string; repeats?: RunnerRepeatLimits } & RunnerCapabilities = {},
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
      input: { title?: string; instructions?: string } & RunnerCapabilities & RunnerSessionSettings = {},
    ): Promise<RunnerResult<{ id: string; created: boolean }>> {
      const base = {
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions.slice(0, 20_000) } : {}),
      }
      const extras = capabilityFields(input)
      let { status, payload } = await request(deps, "PUT", sessionPath(id), { ...base, ...extras })
      // A runner older than per-session capabilities rejects them: keep the conversation, without them. A conversation
      // that belongs to someone (owner) is never created without that: it could not be found again.
      if (unknownSetting(status, payload) && Object.keys(extras).length && !input.owner) ({ status, payload } = await request(deps, "PUT", sessionPath(id), base))
      const saved = z.object({ id: z.string() }).safeParse(payload)
      if ((status !== 200 && status !== 201) || !saved.success) return { ok: false, status, error: errorCode(payload, `headless_put_${status}`) }
      return { ok: true, value: { id: saved.data.id, created: status === 201 } }
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
        headers: { authorization: `Bearer ${deps.config.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response.status !== 200) return { ok: false, status: response.status, error: `headless_file_${response.status}` }
      return { ok: true, value: { content: await response.text() } }
    },

    /**
     * Sends one turn with a fresh member-scoped MCP token. Re-sending the same
     * messageId never starts a second turn; it resumes an interrupted one.
     */
    async sendTurn(
      actor: HeadlessRunnerActor,
      input: { sessionId: string; messageId: string; prompt: string; model?: string; ttlMs?: number; attachments?: string[]; readOnly?: boolean },
    ): Promise<RunnerResult<{ state: string }>> {
      const ttlMs = Math.min(input.ttlMs ?? deps.maxTokenTtlMs, deps.maxTokenTtlMs)
      const { token } = await deps.mintToken({ ...actor, ttlMs, messageId: input.messageId, ...(input.readOnly ? { readOnly: true } : {}) })
      const { status, payload } = await request(deps, "POST", `${sessionPath(input.sessionId)}/turns`, {
        messageId: input.messageId,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        credentials: { mcpToken: token, ...(input.readOnly ? { readOnly: true } : {}) },
      })
      if (status !== 202) return { ok: false, status, error: errorCode(payload, `headless_send_${status}`) }
      const accepted = z.object({ state: z.string() }).safeParse(payload)
      return { ok: true, value: { state: accepted.success ? accepted.data.state : "accepted" } }
    },

    /** `outputs: "none"` leaves tool outputs on the runner when a caller only needs each tool's outcome. */
    async readSession(
      sessionId: string,
      input: { messageId?: string; limit?: number; outputs?: "none"; turns?: number; before?: string } = {},
    ): Promise<RunnerResult<RunnerSnapshot>> {
      const query = new URLSearchParams({ limit: String(input.limit ?? 500) })
      if (input.messageId) query.set("messageId", input.messageId)
      if (input.outputs) query.set("outputs", input.outputs)
      if (input.turns) query.set("turns", String(input.turns))
      if (input.before) query.set("before", input.before)
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
        headers: { authorization: `Bearer ${deps.config.token}`, "content-type": input.mediaType || "application/octet-stream" },
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
        headers: { authorization: `Bearer ${deps.config.token}` },
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
        headers: { authorization: `Bearer ${deps.config.token}` },
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
        headers: { authorization: `Bearer ${deps.config.token}` },
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
        headers: { authorization: `Bearer ${deps.config.token}`, accept: "text/event-stream" },
        signal,
      })
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined)
        return null
      }
      return response
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

    /** The models the runner's Gateway route can serve. Null when unavailable. */
    async listModels(): Promise<HeadlessModelCatalog | null> {
      try {
        const { status, payload } = await request(deps, "GET", "/v1/models")
        const parsed = modelCatalogSchema.safeParse(payload)
        return status === 200 && parsed.success ? parsed.data : null
      } catch {
        return null
      }
    },
  }
}

export type HeadlessRunnerClient = ReturnType<typeof createHeadlessRunnerClient>
