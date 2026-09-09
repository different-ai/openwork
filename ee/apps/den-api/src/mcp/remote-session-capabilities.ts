import { createHeadlessThreadClient, toTranscript, type AgentSessionClient, type HeadlessThreadModel } from "@openwork/headless-threads"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { desktopRunnerConnected } from "@openwork/automations"
import { REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY } from "@openwork/types/automations"
import { db } from "../db.js"
import { env } from "../env.js"
import {
  getOpenWorkWebRuntimeAccess,
  OPENWORK_WEB_ACCESS_REQUIRED_CODE,
  OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
  type OpenWorkWebRuntimeAccessResolver,
} from "../openwork-web-runtime-access.js"
// The automation repository is the presence source of truth. Importing the
// automation service instead would pull the codemode execution graph (and
// its `effect` dependency) into every spec that imports this module, which
// the evals layer rules forbid.
import { automationRepository } from "../automations/repository.js"
import { cloudHostingAvailable } from "../capability-sources/cloud-hosting.js"
import {
  databaseRemoteSessionCommandStore,
  DEFAULT_TTL_MS,
  type RemoteSessionCommandStore,
} from "../remote-sessions/commands.js"
import { resolveCloudRuntimeAccess, type CloudWorkerAccess } from "../workers/worker-access.js"
import { fetchPreviewNoRedirect, previewFetch } from "../workers/preview-fetch.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

/**
 * Remote sessions over the capability gateway: create and drive a native
 * OpenWork session on the member's OpenWork Cloud worker or connected
 * desktop — from any MCP client.
 */

export const REMOTE_SESSION_CAPABILITY_PREFIX = "remote-session:"
export const REMOTE_SESSION_ACTIONS = ["create", "send", "read"] as const
export type RemoteSessionAction = (typeof REMOTE_SESSION_ACTIONS)[number]

export function remoteSessionCapabilityName(action: RemoteSessionAction): string {
  return `${REMOTE_SESSION_CAPABILITY_PREFIX}${action}`
}

export function parseRemoteSessionCapabilityName(name: string): RemoteSessionAction | null {
  if (!name.startsWith(REMOTE_SESSION_CAPABILITY_PREFIX)) return null
  const action = name.slice(REMOTE_SESSION_CAPABILITY_PREFIX.length)
  return REMOTE_SESSION_ACTIONS.find((candidate) => candidate === action) ?? null
}

const modelSchema = z.object({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  variant: z.string().trim().min(1).optional(),
})

const createBodySchema = z.object({
  target: z.enum(["cloud", "desktop"]).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  prompt: z.string().min(1).max(100_000).optional(),
  model: modelSchema.optional(),
})

const sendBodySchema = z.object({
  sessionId: z.string().trim().min(1),
  prompt: z.string().min(1).max(100_000),
  model: modelSchema.optional(),
})

const readBodySchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  commandId: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).superRefine((body, context) => {
  if (Number(body.sessionId !== undefined) + Number(body.commandId !== undefined) !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of sessionId or commandId is required.",
    })
  }
})

const BODY_SCHEMAS: Record<RemoteSessionAction, z.ZodTypeAny> = {
  create: createBodySchema,
  send: sendBodySchema,
  read: readBodySchema,
}

type RemoteSessionDefinition = {
  action: RemoteSessionAction
  summary: string
  searchExtraTokens: string
  argumentsSchema: Record<string, unknown>
}

const MODEL_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    providerId: { type: "string" },
    modelId: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerId", "modelId"],
} as const

const REMOTE_SESSION_DEFINITIONS: RemoteSessionDefinition[] = [
  {
    action: "create",
    summary:
      "Start a remote session: a native OpenWork chat on your OpenWork Web instance (runs in the cloud, visible in the browser). Automatically sets up your workspace on first use; on cloud_runtime_provisioning, wait retryAfterMs before retrying with the same arguments. Give it the task to run as prompt. target \"desktop\" runs it on your connected OpenWork desktop instead.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web instance browser openwork desktop create start new open run do task work delegate hand off handoff background continue workspace",
    argumentsSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["cloud", "desktop"], description: "Where the session runs. Defaults to \"cloud\" (your OpenWork Web instance)." },
        title: { type: "string", maxLength: 120, description: "Session title shown in OpenWork." },
        prompt: { type: "string", description: "Optional first prompt. When present the session starts working immediately." },
        model: MODEL_ARGUMENT_SCHEMA,
      },
    },
  },
  {
    action: "send",
    summary:
      "Send a follow-up prompt to an existing remote session on your OpenWork Web instance. Returns an acceptance receipt; poll remote-session:read for the reply.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web instance send prompt message turn continue follow up reply ask tell",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id returned by remote-session:create." },
        prompt: { type: "string" },
        model: MODEL_ARGUMENT_SCHEMA,
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    action: "read",
    summary:
      "Read a remote session's recent transcript and status from your OpenWork Web instance, or the status of a queued desktop command.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web instance read transcript status reply answer poll result output check progress desktop command",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id returned by remote-session:create." },
        commandId: { type: "string", description: "Desktop command id returned by remote-session:create." },
        limit: { type: "number", description: "Maximum number of recent messages to return. Defaults to 20, max 100." },
      },
      oneOf: [{ required: ["sessionId"] }, { required: ["commandId"] }],
    },
  },
]

export type RemoteSessionCapabilityMatch = CapabilityMatch & { kind: "remote_session" }

export function searchRemoteSessionCapabilities(query: string, limit = 5): RemoteSessionCapabilityMatch[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  const matches: RemoteSessionCapabilityMatch[] = []
  for (const definition of REMOTE_SESSION_DEFINITIONS) {
    const name = remoteSessionCapabilityName(definition.action)
    const score = scoreText(
      tokenize(`remote session ${definition.action}`),
      tokenize(definition.summary),
      queryTokens,
      tokenize(definition.searchExtraTokens),
    )
    if (score <= 0) continue
    matches.push({
      name,
      method: "SESSION",
      path: name,
      score,
      summary: definition.summary,
      pathParams: [],
      queryParams: [],
      hasBody: true,
      argumentsSchema: definition.argumentsSchema,
      invocation: { argumentsField: "body" },
      kind: "remote_session",
    })
  }

  return matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(20, Math.trunc(limit) || 5)))
}

export type RemoteSessionRuntime = {
  workerId: string
  baseUrl: string
  workspaceId: string
  clientToken: string
  hostToken: string
}

export type RemoteSessionRuntimeResult =
  | { ok: true; runtime: RemoteSessionRuntime }
  | {
      ok: false
      error: "cloud_not_available" | "needs_cloud_setup" | "cloud_runtime_provisioning" | "cloud_runtime_failed" | "cloud_runtime_waking" | "cloud_runtime_unreachable"
      message: string
      retryable: boolean
      retryAfterMs?: number
    }

export type RemoteSessionThreadClient = Pick<AgentSessionClient, "createThread" | "sendTurn" | "getThreadSnapshot">

export type RemoteSessionExecuteDeps = {
  getOpenWorkWebAccess: OpenWorkWebRuntimeAccessResolver
  resolveRuntime: (scope: { organizationId: DenTypeId<"organization">; userId: string; provisionIfMissing?: boolean }) => Promise<RemoteSessionRuntimeResult>
  createClient: (runtime: RemoteSessionRuntime) => RemoteSessionThreadClient
  commandStore: RemoteSessionCommandStore
  desktopPresence: (scope: {
    organizationId: DenTypeId<"organization">
    userId: string
  }) => Promise<{ connected: boolean; ownerMemberId: string | null }>
}

export type RemoteSessionToolResult = {
  isError?: boolean
  content: { type: "text"; text: string }[]
  structuredContent?: Record<string, unknown>
}

const READY_BUDGET_MS = 25_000
const READY_POLL_MS = 1_000
const WORKER_REQUEST_TIMEOUT_MS = 10_000
const READ_DEFAULT_MESSAGE_LIMIT = 20
const READ_MESSAGE_TEXT_LIMIT = 4_000
const FINAL_TEXT_LIMIT = 20_000

const NEEDS_SETUP_MESSAGE =
  "No OpenWork Cloud workspace exists for your account yet. Use remote-session:create to start a new task and set up your workspace automatically."

function provisioningResult(): RemoteSessionRuntimeResult {
  return {
    ok: false,
    error: "cloud_runtime_provisioning",
    message: "Your OpenWork Cloud workspace is being set up. No task has been submitted yet. Retry remote-session:create with the same arguments in about 30 seconds; you do not need to open the web app.",
    retryable: true,
    retryAfterMs: 30_000,
  }
}

const CLOUD_NOT_AVAILABLE_MESSAGE =
  "OpenWork Cloud is not available on this deployment, so remote sessions are unavailable."

/**
 * Whether the remote-session capabilities exist on this deployment at all.
 * When Den cannot host Cloud (self-hosted single-org mode or no Daytona
 * provisioner), the capabilities are hidden from search and execute reports
 * them as unknown. Organization entitlement is enforced at execution time by
 * the OpenWork Web access check, which returns a clear access-required error.
 */
export function remoteSessionCapabilitiesEnabled(
  _organizationMetadata?: Record<string, unknown> | string | null | undefined,
): boolean {
  if (env.provisionerMode !== "daytona" || !env.daytona.apiKey) return false
  return cloudHostingAvailable({ orgMode: env.orgMode })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeToolBody(body: unknown): unknown {
  if (typeof body !== "string") return body
  const trimmed = body.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body
  try {
    return JSON.parse(trimmed)
  } catch {
    return body
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workerHeaders(access: CloudWorkerAccess) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${access.clientToken}`,
    "X-OpenWork-Host-Token": access.hostToken,
  }
}

export async function resolveRemoteSessionWorkspace(
  access: CloudWorkerAccess,
  fetchImpl: typeof fetch = fetch,
) {
  try {
    const response = await fetchPreviewNoRedirect(fetchImpl, `${access.url}/workspaces`, {
      headers: workerHeaders(access),
      signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (isRecord(payload) && typeof payload.activeId === "string" && payload.activeId) {
      return { baseUrl: access.url, workspaceId: payload.activeId }
    }
  } catch {
    return null
  }
  return null
}

async function defaultResolveRuntime(
  scope: { organizationId: DenTypeId<"organization">; userId: string; provisionIfMissing?: boolean },
): Promise<RemoteSessionRuntimeResult> {
  // Defense in depth: the registry already hides these capabilities when the
  // deployment cannot host Cloud, but the runtime re-checks so the runtime
  // cannot execute against stale visibility. Organization entitlement was
  // already confirmed by the OpenWork Web access check in executeRemoteSessionCapability.
  if (!remoteSessionCapabilitiesEnabled()) {
    return { ok: false, error: "cloud_not_available", message: CLOUD_NOT_AVAILABLE_MESSAGE, retryable: false }
  }

  const deadline = Date.now() + READY_BUDGET_MS
  for (;;) {
    const access = await resolveCloudRuntimeAccess({
      organizationId: scope.organizationId,
      userId: normalizeDenTypeId("user", scope.userId),
    })
    if (access.status === "missing") {
      if (scope.provisionIfMissing) {
        // Load on first use to avoid a startup cycle through the route and MCP
        // registries. Browser and MCP creation share one store and in-flight map.
        const { ensureMemberCloudWorker } = await import("../routes/cloud/index.js")
        await ensureMemberCloudWorker({
          orgId: scope.organizationId,
          createdByUserId: normalizeDenTypeId("user", scope.userId),
        })
        return provisioningResult()
      }
      return { ok: false, error: "needs_cloud_setup", message: NEEDS_SETUP_MESSAGE, retryable: false }
    }
    if (access.status === "provisioning" && scope.provisionIfMissing) return provisioningResult()
    if (access.status !== "ready" && access.reason === "unreachable") {
      return {
        ok: false,
        error: "cloud_runtime_unreachable",
        message: "Your OpenWork Cloud workspace is running but cannot be reached right now. Retry after the network path recovers.",
        retryable: true,
      }
    }
    if (access.status === "failed") {
      return {
        ok: false,
        error: "cloud_runtime_failed",
        message: "Your OpenWork Cloud workspace needs repair before remote sessions can run. Open OpenWork Cloud in the browser to let it recover, then retry.",
        retryable: false,
      }
    }
    if (access.status === "ready") {
      const workspace = await resolveRemoteSessionWorkspace(access)
      if (workspace) {
        return {
          ok: true,
          runtime: {
            workerId: access.workerId,
            baseUrl: workspace.baseUrl,
            workspaceId: workspace.workspaceId,
            clientToken: access.clientToken,
            hostToken: access.hostToken,
          },
        }
      }
      return {
        ok: false,
        error: "cloud_runtime_unreachable",
        message: "Your OpenWork Cloud workspace is healthy but its session API cannot be reached right now. Retry after the network path recovers.",
        retryable: true,
      }
    }
    if (Date.now() >= deadline) break
    await sleep(READY_POLL_MS)
  }

  return {
    ok: false,
    error: "cloud_runtime_waking",
    message: "Your OpenWork Cloud workspace is still starting. Retry the same call in about 30 seconds.",
    retryable: true,
  }
}

function defaultCreateClient(runtime: RemoteSessionRuntime): RemoteSessionThreadClient {
  return createHeadlessThreadClient({
    baseUrl: runtime.baseUrl,
    workspaceId: runtime.workspaceId,
    token: runtime.clientToken,
    hostToken: runtime.hostToken,
    requestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS,
    fetch: (url, init = {}) => fetchPreviewNoRedirect(previewFetch(), url, init),
  })
}

async function defaultDesktopPresence(scope: {
  organizationId: DenTypeId<"organization">
  userId: string
}): Promise<{ connected: boolean; ownerMemberId: string | null }> {
  const members = await db.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, scope.organizationId),
    eq(MemberTable.userId, normalizeDenTypeId("user", scope.userId)),
    isNull(MemberTable.removedAt),
  )).limit(1)
  const ownerMemberId = members[0]?.id ?? null
  if (!ownerMemberId) return { connected: false, ownerMemberId: null }
  const lastSeenAt = await automationRepository.desktopRunnerCapabilityLastSeenAt({
    organizationId: scope.organizationId,
    ownerMemberId,
    capability: REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  })
  return { connected: desktopRunnerConnected({ lastSeenAt, now: Date.now() }), ownerMemberId }
}

export const DEFAULT_REMOTE_SESSION_DEPS: RemoteSessionExecuteDeps = {
  getOpenWorkWebAccess: getOpenWorkWebRuntimeAccess,
  resolveRuntime: defaultResolveRuntime,
  createClient: defaultCreateClient,
  commandStore: databaseRemoteSessionCommandStore,
  desktopPresence: defaultDesktopPresence,
}

function jsonResult(payload: Record<string, unknown>, isError = false): RemoteSessionToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function errorResult(payload: Record<string, unknown>): RemoteSessionToolResult {
  return jsonResult(payload, true)
}

function threadErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null
  return typeof error.status === "number" ? error.status : null
}

function threadErrorResult(action: RemoteSessionAction, sessionId: string | null, error: unknown): RemoteSessionToolResult {
  const status = threadErrorStatus(error)
  // The worker binds HTTP before its managed engine finishes starting. Only
  // retry creation when the session endpoint itself rejected the request;
  // a later prompt failure may already have created a session.
  if (action === "create" && status === 400 && isRecord(error)
    && error.code === "opencode_unconfigured" && typeof error.path === "string"
    && error.path.endsWith("/opencode/session")) {
    return errorResult({
      error: "cloud_runtime_waking",
      message: "Your OpenWork Cloud workspace is reachable, but its engine is not ready yet. Retry the same call in about 30 seconds; no session was created.",
      retryable: true,
      retryAfterMs: 30_000,
    })
  }
  if (status === 404 && sessionId) {
    return errorResult({
      error: "unknown_session",
      message: `No remote session "${sessionId}" exists on your OpenWork Cloud workspace. It may have been deleted; create a new one with remote-session:create.`,
      retryable: false,
    })
  }
  const message = error instanceof Error ? error.message : "The OpenWork Cloud workspace request failed."
  return errorResult({
    error: "remote_session_request_failed",
    message: `remote-session:${action} failed: ${message}`,
    retryable: status === null || status >= 500,
  })
}

function modelInput(model: z.infer<typeof modelSchema> | undefined): HeadlessThreadModel | undefined {
  if (!model) return undefined
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

export type RemoteSessionExecuteInput = {
  action: RemoteSessionAction
  organizationId: DenTypeId<"organization">
  userId: string
  hasWriteScope: boolean
  body: unknown
}

export async function executeRemoteSessionCapability(
  input: RemoteSessionExecuteInput,
  deps: RemoteSessionExecuteDeps = DEFAULT_REMOTE_SESSION_DEPS,
): Promise<RemoteSessionToolResult> {
  if ((input.action === "create" || input.action === "send") && !input.hasWriteScope) {
    return errorResult({
      error: "insufficient_mcp_scope",
      message: `remote-session:${input.action} requires the mcp:write scope.`,
      retryable: false,
    })
  }

  const parsedBody = BODY_SCHEMAS[input.action].safeParse(normalizeToolBody(input.body) ?? {})
  if (!parsedBody.success) {
    return errorResult({
      error: "invalid_capability_arguments",
      message: `Invalid arguments for remote-session:${input.action}.`,
      issues: parsedBody.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      retryable: false,
    })
  }

  if (input.action === "read") {
    const body = readBodySchema.parse(parsedBody.data)
    if (body.commandId) {
      const command = await deps.commandStore.get({
        commandId: body.commandId,
        organizationId: input.organizationId,
        createdByUserId: input.userId,
      })
      if (!command) return errorResult({ error: "unknown_command" })
      return jsonResult({
        commandId: command.id,
        target: "desktop",
        state: command.status,
        sessionId: command.sessionId,
        workspaceId: command.workspaceId,
        resultSummary: command.resultSummary,
        error: command.error,
        expiresAt: command.expiresAt,
      })
    }
  }

  // Entitlement precedes every execution branch. Queuing a remote session for a
  // connected desktop is remote control of that machine, so it is gated like
  // Cloud execution; only the status read of an already queued command above
  // stays available without Web access.
  const webAccess = await deps.getOpenWorkWebAccess(input.organizationId)
  if (!webAccess.hasAccess) {
    return errorResult({
      error: OPENWORK_WEB_ACCESS_REQUIRED_CODE,
      message: OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
      retryable: false,
    })
  }

  if (input.action === "create") {
    const body = createBodySchema.parse(parsedBody.data)
    if (body.target === "desktop") {
      const presence = await deps.desktopPresence({ organizationId: input.organizationId, userId: input.userId })
      if (!presence.connected || !presence.ownerMemberId) {
        return errorResult({
          error: "desktop_offline",
          message: "No desktop is connected for your account. Open the OpenWork desktop app and try again.",
        })
      }
      const command = await deps.commandStore.enqueue({
        organizationId: input.organizationId,
        ownerMemberId: presence.ownerMemberId,
        createdByUserId: input.userId,
        title: body.title ?? "Remote session",
        ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ttlMs: DEFAULT_TTL_MS,
        idempotencyKey: createDenTypeId("remoteSessionCommand"),
      })
      return jsonResult({
        target: "desktop",
        state: "queued",
        commandId: command.id,
        expiresAt: command.expiresAt,
      })
    }
  }

  const runtime = await deps.resolveRuntime({
    organizationId: input.organizationId,
    userId: input.userId,
    provisionIfMissing: input.action === "create",
  })
  if (!runtime.ok) {
    return errorResult({
      error: runtime.error,
      message: runtime.message,
      retryable: runtime.retryable,
      ...(runtime.retryAfterMs === undefined ? {} : { retryAfterMs: runtime.retryAfterMs }),
    })
  }

  const client = deps.createClient(runtime.runtime)

  if (input.action === "create") {
    const body = createBodySchema.parse(parsedBody.data)
    try {
      const thread = await client.createThread({
        title: body.title ?? "Remote session",
        ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
        ...(modelInput(body.model) === undefined ? {} : { model: modelInput(body.model) }),
      })
      return jsonResult({
        target: "cloud",
        sessionId: thread.id,
        workspaceId: thread.workspaceId,
        workerId: runtime.runtime.workerId,
        title: thread.title,
        started: thread.started,
        note: "This is a native OpenWork session on your OpenWork Web instance; it is visible in OpenWork Web. Use remote-session:send for follow-ups and remote-session:read to read replies.",
      })
    } catch (error) {
      return threadErrorResult("create", null, error)
    }
  }

  if (input.action === "send") {
    const body = sendBodySchema.parse(parsedBody.data)
    try {
      const accepted = await client.sendTurn(body.sessionId, {
        prompt: body.prompt,
        ...(modelInput(body.model) === undefined ? {} : { model: modelInput(body.model) }),
      })
      return jsonResult({
        target: "cloud",
        sessionId: body.sessionId,
        state: "accepted",
        messageId: accepted.messageId,
        alreadyPresent: accepted.alreadyPresent,
        note: "The prompt was accepted asynchronously. Poll remote-session:read for the reply.",
      })
    } catch (error) {
      return threadErrorResult("send", body.sessionId, error)
    }
  }

  const body = readBodySchema.parse(parsedBody.data)
  if (!body.sessionId) throw new Error("remote_session_read_body_invariant")
  try {
    const snapshot = await client.getThreadSnapshot(body.sessionId)
    const transcript = toTranscript(snapshot)
    const limit = body.limit ?? READ_DEFAULT_MESSAGE_LIMIT
    return jsonResult({
      target: "cloud",
      sessionId: body.sessionId,
      title: transcript.title,
      status: snapshot.status.type,
      messageCount: transcript.messages.length,
      messages: transcript.messages.slice(-limit).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text.slice(0, READ_MESSAGE_TEXT_LIMIT),
        toolCalls: message.toolCalls.map((tool) => ({ name: tool.name, status: tool.status })),
      })),
      finalAssistantText: transcript.finalAssistantText.slice(0, FINAL_TEXT_LIMIT),
      ...(transcript.terminalError ? { terminalError: transcript.terminalError } : {}),
    })
  } catch (error) {
    return threadErrorResult("read", body.sessionId, error)
  }
}
