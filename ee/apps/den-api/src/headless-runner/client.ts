import { z } from "zod"
import { DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS } from "../mcp/headless-run-token.js"

/**
 * Den's one client for the shared headless runner (ee/apps/headless-runner).
 *
 * Slack replies, cloud Automations and Workbot all run agent turns there. Each
 * surface authorizes the member first; this client then mints a short-lived,
 * member-scoped OpenWork MCP token for every turn it sends, so the runner can
 * only reach what that member can reach, and only for the life of the turn.
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
  return { url: url.replace(/\/+$/, ""), token }
}

export type HeadlessRunnerActor = { userId: string; organizationId: string }

export type HeadlessRunnerDeps = {
  config: HeadlessRunnerConfig
  fetch: typeof fetch
  mintToken: (input: HeadlessRunnerActor & { ttlMs?: number }) => Promise<{ token: string }>
}

export function defaultHeadlessRunnerDeps(env: Record<string, string | undefined> = process.env): HeadlessRunnerDeps | null {
  const config = headlessRunnerConfig(env)
  // Loaded lazily: the minter pulls in the auth and database modules.
  const mintToken: HeadlessRunnerDeps["mintToken"] = async (input) =>
    (await import("../mcp/headless-run-token-mint.js")).mintHeadlessRunMcpToken(input)
  return config ? { config, fetch, mintToken } : null
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
})
export type RunnerTurn = z.infer<typeof runnerTurnSchema>

const runnerToolCallSchema = z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
export const runnerMessageSchema = z.discriminatedUnion("role", [
  z.object({ seq: z.number().optional(), messageId: z.string().optional(), role: z.literal("user"), text: z.string() }),
  z.object({
    seq: z.number().optional(),
    messageId: z.string().optional(),
    role: z.literal("assistant"),
    text: z.string(),
    toolCalls: z.array(runnerToolCallSchema),
  }),
  z.object({
    seq: z.number().optional(),
    messageId: z.string().optional(),
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
})

export type RunnerSnapshot = {
  turns: RunnerTurn[]
  /** Transcript entries the runner returned that Den understands; unknown shapes are skipped. */
  messages: RunnerMessage[]
  finalAssistantText: string
}

export const ACTIVE_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["queued", "running"])
export const TERMINAL_TURN_STATUSES: ReadonlySet<RunnerTurnStatus> = new Set(["completed", "failed", "aborted"])

const modelCatalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
})
export type HeadlessModelCatalog = z.infer<typeof modelCatalogSchema>

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

export function createHeadlessRunnerClient(deps: HeadlessRunnerDeps) {
  return {
    async createSession(input: { title?: string; instructions?: string } = {}): Promise<RunnerResult<{ id: string }>> {
      const { status, payload } = await request(deps, "POST", "/v1/sessions", {
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        ...(input.instructions ? { instructions: input.instructions.slice(0, 20_000) } : {}),
      })
      const created = z.object({ id: z.string() }).safeParse(payload)
      if (status !== 201 || !created.success) return { ok: false, status, error: errorCode(payload, `headless_create_${status}`) }
      return { ok: true, value: { id: created.data.id } }
    },

    /**
     * Creates the session under a caller-chosen id (`hs_…`), or updates its
     * title and instructions. One durable conversation per person needs no
     * Den-side mapping: the caller derives the id.
     */
    async putSession(id: string, input: { title?: string; instructions?: string } = {}): Promise<RunnerResult<{ id: string; created: boolean }>> {
      const { status, payload } = await request(deps, "PUT", sessionPath(id), {
        ...(input.title ? { title: input.title.slice(0, 200) } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions.slice(0, 20_000) } : {}),
      })
      const saved = z.object({ id: z.string() }).safeParse(payload)
      if ((status !== 200 && status !== 201) || !saved.success) return { ok: false, status, error: errorCode(payload, `headless_put_${status}`) }
      return { ok: true, value: { id: saved.data.id, created: status === 201 } }
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
      input: { sessionId: string; messageId: string; prompt: string; model?: string; ttlMs?: number },
    ): Promise<RunnerResult<{ state: string }>> {
      const ttlMs = Math.min(input.ttlMs ?? DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS, DEN_MCP_HEADLESS_RUN_TOKEN_MAX_TTL_MS)
      const { token } = await deps.mintToken({ ...actor, ttlMs })
      const { status, payload } = await request(deps, "POST", `${sessionPath(input.sessionId)}/turns`, {
        messageId: input.messageId,
        prompt: input.prompt,
        ...(input.model ? { model: input.model } : {}),
        credentials: { mcpToken: token },
      })
      if (status !== 202) return { ok: false, status, error: errorCode(payload, `headless_send_${status}`) }
      const accepted = z.object({ state: z.string() }).safeParse(payload)
      return { ok: true, value: { state: accepted.success ? accepted.data.state : "accepted" } }
    },

    async readSession(sessionId: string, input: { messageId?: string; limit?: number } = {}): Promise<RunnerResult<RunnerSnapshot>> {
      const query = new URLSearchParams({ limit: String(input.limit ?? 500) })
      if (input.messageId) query.set("messageId", input.messageId)
      const { status, payload } = await request(deps, "GET", `${sessionPath(sessionId)}?${query.toString()}`)
      if (status !== 200) return { ok: false, status, error: errorCode(payload, `headless_read_${status}`) }
      const snapshot = runnerSnapshotSchema.safeParse(payload)
      if (!snapshot.success) return { ok: false, status, error: "headless_read_invalid" }
      return {
        ok: true,
        value: {
          turns: snapshot.data.turns,
          finalAssistantText: snapshot.data.finalAssistantText,
          messages: snapshot.data.messages.flatMap((entry) => {
            const parsed = runnerMessageSchema.safeParse(entry)
            return parsed.success ? [parsed.data] : []
          }),
        },
      }
    },

    /**
     * Stops one turn, or without a messageId everything running or queued in
     * the session. `reached` is the runner answering; `stopped` is whether
     * anything was still running or queued to stop.
     */
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
