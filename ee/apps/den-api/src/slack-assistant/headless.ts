import { z } from "zod"
import type { RemoteSessionAction } from "../mcp/remote-session-capabilities.js"
import { organizationHasCapability } from "../organization-capabilities.js"

/**
 * Slack runs for organizations with `slackAssistantHeadless` go to the shared
 * headless runner (ee/apps/headless-runner) instead of each member's OpenWork
 * Web computer. This adapter speaks the same create/send/read/stop contract
 * the Slack run loop already uses, so run.ts stays runtime-agnostic.
 *
 * Runs have no time limit. Each MCP token still lives at most 60 minutes: the
 * runner pauses a long turn between steps every 50 minutes, and the read below
 * resumes it at once with a freshly minted token.
 *
 * A/B: an optional second runner ("B", for example the Worker build) can take a
 * share of new sessions. A session stays on the runner that created it: B
 * session ids are stored with a `b:` prefix, so later calls reach the same runner.
 */

type HeadlessConfig = { url: string; token: string }

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

export function headlessRunnerConfig(env: Record<string, string | undefined> = process.env): HeadlessConfig | null {
  const url = env.DEN_HEADLESS_RUNNER_URL?.trim()
  const token = env.DEN_HEADLESS_RUNNER_TOKEN?.trim()
  if (!url || !token || token.length < 32 || !isSafeRunnerUrl(url)) return null
  return { url: url.replace(/\/+$/, ""), token }
}

/** Session ids created on runner B carry this prefix in Den; the runner itself never sees it. */
const B_PREFIX = "b:"

/** Runner B and which new sessions it takes: every listed organization, plus `percent` of the rest. */
export type HeadlessSplit = { config: HeadlessConfig; percent: number; organizations: ReadonlySet<string> }

export function headlessRunnerSplit(env: Record<string, string | undefined> = process.env): HeadlessSplit | null {
  const url = env.DEN_HEADLESS_RUNNER_B_URL?.trim()
  const token = env.DEN_HEADLESS_RUNNER_B_TOKEN?.trim()
  if (!url || !token || token.length < 32 || !isSafeRunnerUrl(url)) return null
  const percent = Number(env.DEN_HEADLESS_RUNNER_B_PERCENT ?? "0")
  const organizations = (env.DEN_HEADLESS_RUNNER_B_ORGANIZATIONS ?? "").split(",").map((id) => id.trim()).filter(Boolean)
  return {
    config: { url: url.replace(/\/+$/, ""), token },
    percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0,
    organizations: new Set(organizations),
  }
}

export type SlackRuntime = "headless" | "web"

/** An organization uses the headless runner only when it is switched on for it and the deployment has one. */
export function slackRuntimeForOrganization(
  metadata: Parameters<typeof organizationHasCapability>[0],
  env: Record<string, string | undefined> = process.env,
): SlackRuntime {
  const enabled = organizationHasCapability(metadata, "slackAssistantHeadless")
  return enabled && headlessRunnerConfig(env) !== null ? "headless" : "web"
}

const turnSchema = z.object({
  messageId: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})
const messageSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("user"), text: z.string() }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })),
  }),
  z.object({ role: z.literal("tool"), callId: z.string(), name: z.string(), isError: z.boolean() }),
])
const snapshotSchema = z.object({
  turns: z.array(turnSchema),
  messages: z.array(z.unknown()),
  finalAssistantText: z.string(),
})

/** A short, human label for one tool step in Slack's task timeline. */
export function stepLabel(name: string, input: Record<string, unknown> = {}) {
  const target = typeof input.name === "string" ? input.name.split(/[:/]/).pop()?.replaceAll("_", " ") : undefined
  const path = typeof input.path === "string" ? input.path : undefined
  switch (name) {
    case "search_capabilities":
      return "Finding the right tool"
    case "execute_capability":
      return target ? `Using ${target}` : "Using your connections"
    case "execute_capability_script":
      return "Running a multi-step action"
    case "list_skills":
    case "get_skill":
      return "Reading skills"
    case "write_file":
    case "edit_file":
      return path ? `Writing ${path}` : "Writing a draft"
    case "read_file":
    case "list_files":
      return path ? `Reading ${path}` : "Reading notes"
    default:
      return name.replaceAll("_", " ")
  }
}

export type HeadlessDeps = {
  /** Runner A: every session unless runner B takes it. */
  config: HeadlessConfig
  /** Runner B for an A/B comparison; null or absent sends everything to A. */
  split?: HeadlessSplit | null
  /** For tests; picks the share of new sessions that go to B. */
  random?: () => number
  fetch: typeof fetch
  /** `messageId` is the Slack run's turn id; Den remembers the run the token was minted for. */
  mintToken: (input: { userId: string; organizationId: string; messageId?: string }) => Promise<{ token: string }>
}

function defaultDeps(): HeadlessDeps | null {
  const config = headlessRunnerConfig()
  // Loaded lazily: the minter pulls in the auth and database modules.
  const mintToken: HeadlessDeps["mintToken"] = async (input) => {
    const minted = await (await import("../mcp/headless-run-token-mint.js")).mintHeadlessRunMcpToken(input)
    try {
      // Work this run hands to the member's desktop then reports back to its Slack thread.
      const { recordSlackRunToken } = await import("./desktop-handoff.js")
      await recordSlackRunToken({ tokenId: minted.tokenId, expiresAt: minted.expiresAt, userId: input.userId, messageId: input.messageId })
    } catch {
      // The run still works; only a desktop handoff's thread report is lost.
    }
    return minted
  }
  return config ? { config, split: headlessRunnerSplit(), fetch, mintToken } : null
}

type Actor = { userId: string; organizationId: string }
type Backend = "a" | "b"
type Target = { backend: Backend; config: HeadlessConfig; sessionId: string }

/** Which runner a new session goes to. */
function pickBackend(deps: HeadlessDeps, actor: Actor): Backend {
  const split = deps.split
  if (!split) return "a"
  if (split.organizations.has(actor.organizationId)) return "b"
  return (deps.random ?? Math.random)() * 100 < split.percent ? "b" : "a"
}

/** The runner that holds a stored session id, and the id that runner knows it by. Null when B is gone. */
function sessionTarget(deps: HeadlessDeps, sessionId: string): Target | null {
  if (!sessionId.startsWith(B_PREFIX)) return { backend: "a", config: deps.config, sessionId }
  return deps.split ? { backend: "b", config: deps.split.config, sessionId: sessionId.slice(B_PREFIX.length) } : null
}

async function call(deps: HeadlessDeps, config: HeadlessConfig, method: string, path: string, body?: unknown) {
  const response = await deps.fetch(`${config.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const payload: unknown = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

/** Runner unavailable or overloaded: the Slack run loop retries these. */
const retryable = (error: string) => ({ error, retryable: true, retryAfterMs: 5_000 })

const catalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.object({ id: z.string(), name: z.string() })),
})

/** The models the runner's Gateway route can serve, for the admin's model picker. Null when unavailable. */
export async function listHeadlessModels(suppliedDeps: HeadlessDeps | null = defaultDeps()) {
  if (!suppliedDeps) return null
  try {
    const { status, payload } = await call(suppliedDeps, suppliedDeps.config, "GET", "/v1/models")
    const parsed = catalogSchema.safeParse(payload)
    return status === 200 && parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

async function send(
  deps: HeadlessDeps,
  target: Target,
  actor: Actor,
  messageId: string,
  prompt: string,
  model?: string,
) {
  // One fresh, member-scoped MCP token per admitted run; the runner holds it in memory only.
  const { token } = await deps.mintToken({ userId: actor.userId, organizationId: actor.organizationId, messageId })
  const { status } = await call(deps, target.config, "POST", `/v1/sessions/${encodeURIComponent(target.sessionId)}/turns`, {
    messageId,
    prompt,
    ...(model ? { model } : {}),
    credentials: { mcpToken: token },
  })
  if (status === 202) return {}
  if (status === 404) return { error: "unknown_session", retryable: false }
  return retryable(`headless_send_${status}`)
}

export async function headlessRemoteCall(
  actor: Actor,
  action: RemoteSessionAction,
  body: Record<string, unknown>,
  suppliedDeps: HeadlessDeps | null = defaultDeps(),
): Promise<Record<string, unknown>> {
  if (!suppliedDeps) return { error: "headless_runner_not_configured", retryable: false }
  const deps = suppliedDeps
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : ""
  const messageId = typeof body.messageId === "string" ? body.messageId : ""

  if (action === "create") {
    const backend = pickBackend(deps, actor)
    const config = backend === "b" && deps.split ? deps.split.config : deps.config
    const { status, payload } = await call(deps, config, "POST", "/v1/sessions", {
      title: typeof body.title === "string" ? body.title.slice(0, 200) : undefined,
    })
    const created = z.object({ id: z.string() }).safeParse(payload)
    if (status !== 201 || !created.success) return retryable(`headless_create_${status}`)
    if (deps.split) console.log(`[slack-assistant] headless session created ${JSON.stringify({ backend, organizationId: actor.organizationId })}`)
    return { sessionId: backend === "b" ? `${B_PREFIX}${created.data.id}` : created.data.id, workspaceId: "headless" }
  }

  const target = sessionTarget(deps, sessionId)
  if (!target) return { error: "headless_runner_b_not_configured", retryable: false }

  if (action === "send") {
    return send(
      deps,
      target,
      actor,
      messageId,
      typeof body.prompt === "string" ? body.prompt : "",
      typeof body.model === "string" ? body.model : undefined,
    )
  }

  if (action === "stop") {
    const { status } = await call(deps, target.config, "POST", `/v1/sessions/${encodeURIComponent(target.sessionId)}/abort`, { messageId })
    return status === 200 ? { accepted: true } : { stopped: false }
  }

  // read: map the runner transcript onto the snapshot shape run.ts consumes. This polls every second for the
  // whole run, so tool outputs (up to 50k characters each) stay on the runner; only their outcome is needed.
  const { status, payload } = await call(
    deps,
    target.config,
    "GET",
    `/v1/sessions/${encodeURIComponent(target.sessionId)}?messageId=${encodeURIComponent(messageId)}&limit=500&outputs=none`,
  )
  if (status === 404) return { error: "unknown_session", retryable: false }
  const snapshot = snapshotSchema.safeParse(payload)
  if (status !== 200 || !snapshot.success) return retryable(`headless_read_${status}`)
  const turn = snapshot.data.turns.find((entry) => entry.messageId === messageId)

  // A runner restart or a credential refresh interrupts a turn; re-sending the same messageId resumes it.
  if (turn?.status === "interrupted") {
    const resumed = await send(deps, target, actor, messageId, "resume")
    if ("error" in resumed) return resumed
  }

  const messages = snapshot.data.messages.flatMap((entry) => {
    const parsed = messageSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
  const results = new Map(
    messages.flatMap((message) => (message.role === "tool" ? [[message.callId, message.isError] as const] : [])),
  )
  const terminal = turn !== undefined && ["completed", "failed", "aborted"].includes(turn.status)
  const failed = turn?.status === "failed"
  if (terminal && deps.split) {
    // One line per finished turn while an A/B split is configured: which runner, how it ended, how long it ran.
    const runnerMs = turn.createdAt !== undefined && turn.updatedAt !== undefined ? turn.updatedAt - turn.createdAt : null
    console.log(`[slack-assistant] headless turn ended ${JSON.stringify({ backend: target.backend, status: turn.status, error: turn.error, runnerMs })}`)
  }
  let finalAssistantText = snapshot.data.finalAssistantText
  if (terminal && !failed && !finalAssistantText) finalAssistantText = "Done."
  // The turn's last message, without the progress notes before it: the answer a long, quiet run posts.
  const lastAssistantText =
    messages.flatMap((message) => (message.role === "assistant" && message.text.trim() ? [message.text] : [])).at(-1) ?? ""
  return {
    status: terminal ? "idle" : "busy",
    title: null,
    messageCount: messages.length,
    finalAssistantText,
    lastAssistantText: lastAssistantText || finalAssistantText,
    ...(failed ? { terminalError: { code: turn.error ?? "headless_run_failed" } } : {}),
    messages: messages.map((message) => ({
      role: message.role,
      toolCalls:
        message.role === "assistant"
          ? message.toolCalls.map((tool) => {
              const outcome = results.get(tool.id)
              return {
                id: tool.id,
                name: stepLabel(tool.name, tool.input),
                status: outcome === undefined ? "running" : outcome ? "error" : "completed",
              }
            })
          : [],
    })),
  }
}
