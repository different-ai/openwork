import { createHeadlessThreadClient, toTranscript, type AgentSessionClient, type HeadlessThreadModel } from "@openwork/headless-threads"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema/org"
import { createDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { desktopRunnerConnected } from "@openwork/automations"
import {
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_TRANSCRIPT_PAGE_MAX,
  type RemoteSessionRequestInput,
  desktopRunnerInventorySchema,
  type DesktopRunnerInventory,
} from "@openwork/types/automations"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
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
import { automationRepository, automationRunnerRowId } from "../automations/repository.js"
import { cloudHostingAvailable } from "../capability-sources/cloud-hosting.js"
import {
  databaseRemoteSessionCommandStore,
  DEFAULT_TTL_MS,
  type RemoteSessionCommandStore,
  type RemoteSessionDesktopSession,
} from "../remote-sessions/commands.js"
import {
  databaseRemoteSessionRequestStore,
  REMOTE_SESSION_REQUEST_TTL_MS,
  type RemoteSessionRequest,
  type RemoteSessionRequestStore,
} from "../remote-sessions/requests.js"
import { cloudRuntimeAvailable } from "../workers/cloud-runtime.js"
import { resolveCloudRuntimeAccess, type CloudWorkerAccess } from "../workers/worker-access.js"
import { fetchPreviewNoRedirect, previewFetch } from "../workers/preview-fetch.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

/**
 * Remote sessions over the capability gateway: create and drive a native
 * OpenWork session on the member's OpenWork Cloud worker or connected
 * desktop — from any MCP client.
 */

export const REMOTE_SESSION_CAPABILITY_PREFIX = "remote-session:"
export const REMOTE_SESSION_ACTIONS = ["create", "send", "read", "stop", "list", "targets"] as const
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
  computerId: z.string().trim().min(1).max(160).optional(),
  workspaceId: z.string().trim().min(1).max(240).optional(),
}).superRefine((body, context) => {
  if (body.target !== "desktop" && (body.computerId !== undefined || body.workspaceId !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [body.computerId !== undefined ? "computerId" : "workspaceId"],
      message: "computerId and workspaceId apply only to target \"desktop\".",
    })
  }
})

const targetsBodySchema = z.object({
  includeModels: z.boolean().optional(),
})

const desktopWorkspaceSchema = z.string().trim().min(1).max(240).optional()

const stopBodySchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: desktopWorkspaceSchema,
  messageId: z.string().optional(),
})

const sendBodySchema = z.object({
  messageId: z.string().regex(/^msg_[a-zA-Z0-9]+$/).optional(),
  sessionId: z.string().trim().min(1),
  workspaceId: desktopWorkspaceSchema,
  prompt: z.string().min(1).max(100_000),
  model: modelSchema.optional(),
})

const readBodySchema = z.object({
  messageId: z.string().optional(),
  sessionId: z.string().trim().min(1).optional(),
  commandId: z.string().trim().min(1).optional(),
  requestId: z.string().trim().min(1).optional(),
  workspaceId: desktopWorkspaceSchema,
  from: z.enum(["start", "end"]).optional(),
  cursor: z.string().trim().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(REMOTE_SESSION_TRANSCRIPT_PAGE_MAX).optional(),
}).superRefine((body, context) => {
  const ids = [body.sessionId, body.commandId, body.requestId].filter((id) => id !== undefined)
  if (ids.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of sessionId, commandId, or requestId is required.",
    })
  }
})

const LIST_DEFAULT_LIMIT = 20
const listBodySchema = z.object({
  target: z.literal("desktop"),
  workspaceId: z.string().trim().min(1).max(240).optional(),
  limit: z.number().int().min(1).max(50).optional(),
})

const BODY_SCHEMAS: Record<RemoteSessionAction, z.ZodTypeAny> = {
  create: createBodySchema,
  send: sendBodySchema,
  read: readBodySchema,
  stop: stopBodySchema,
  list: listBodySchema,
  targets: targetsBodySchema,
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
    action: "targets",
    summary:
      "List where remote-session:create can run for you: your OpenWork desktops (computerId, label, online) with their workspaces (workspaceId, name, active, engine, defaultModel), and whether your OpenWork Web cloud is available. Call this first when the task needs a specific computer, workspace or model. Pass includeModels true to also list each workspace's models.",
    searchExtraTokens:
      "remote session targets list computers desktops machines laptops devices workspaces projects folders models providers where which choose pick select available online cloud",
    argumentsSchema: {
      type: "object",
      properties: {
        includeModels: { type: "boolean", description: "Also list each workspace's available models. Defaults to false to keep the response small." },
      },
    },
  },
  {
    action: "stop",
    summary: "Stop a running remote session on your OpenWork Web instance, or on your desktop for a session created with target \"desktop\". A desktop that has not answered within about 20 seconds returns state \"pending\" with a requestId to collect through remote-session:read.",
    searchExtraTokens: "remote session stop abort cancel running",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from remote-session:create, from remote-session:read with a desktop commandId, or from remote-session:list." },
        workspaceId: { type: "string", description: "Desktop sessions: the session's workspaceId, when one session id could exist in several workspaces." },
        messageId: { type: "string", description: "Optional guard: stop only if this is still the latest user turn." },
      },
      required: ["sessionId"],
    },
  },
  {
    action: "create",
    summary:
      "Start a remote session: a native OpenWork chat on your OpenWork Web instance (runs in the cloud, visible in the browser). Automatically sets up your workspace on first use; on cloud_runtime_provisioning, wait retryAfterMs before retrying with the same arguments. Give it the task to run as prompt. target \"desktop\" runs it on your connected OpenWork desktop instead; to choose which computer, workspace or model, call remote-session:targets first and pass computerId and workspaceId from it.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web instance browser openwork desktop create start new open run do task work delegate hand off handoff background continue workspace",
    argumentsSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["cloud", "desktop"], description: "Where the session runs. Defaults to \"cloud\" (your OpenWork Web instance)." },
        title: { type: "string", maxLength: 120, description: "Session title shown in OpenWork." },
        prompt: { type: "string", description: "Optional first prompt. When present the session starts working immediately." },
        model: MODEL_ARGUMENT_SCHEMA,
        computerId: { type: "string", description: "target \"desktop\" only: the computerId from remote-session:targets. Omit to let any of your connected desktops take it." },
        workspaceId: { type: "string", description: "target \"desktop\" only: the workspaceId from remote-session:targets. Omit to use the desktop's active workspace." },
      },
    },
  },
  {
    action: "send",
    summary:
      "Send a follow-up prompt to an existing remote session on your OpenWork Web instance, or on your desktop for a session created with target \"desktop\". Returns an acceptance receipt; poll remote-session:read for the reply (for a desktop session, read with its commandId until session.status settles again). A desktop that has not answered within about 20 seconds returns state \"pending\" with a requestId to collect through remote-session:read.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web instance send prompt message turn continue follow up reply ask tell",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from remote-session:create, from remote-session:read with a desktop commandId, or from remote-session:list." },
        workspaceId: { type: "string", description: "Desktop sessions: the session's workspaceId, when one session id could exist in several workspaces." },
        messageId: { type: "string", description: "Optional stable msg_ id for idempotent retries." },
        prompt: { type: "string" },
        model: MODEL_ARGUMENT_SCHEMA,
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    action: "read",
    summary:
      "Read a remote session's recent transcript and status from your OpenWork Web instance, or the status of a desktop command, including which computer (computerId) took it. For a desktop command, poll with commandId until state is failed or expired, or session.status is idle (session.finalText holds the answer) or error (session.lastError). When session.status is waiting, tell the person the desktop needs them to answer a session.waitingFor (permission or question) prompt in OpenWork. With the sessionId of a desktop session, returns a transcript page (full message text, tool calls, status) read from the desktop; page with from and cursor/nextCursor. If the desktop has not answered within about 20 seconds the result is state \"pending\" with a requestId: call remote-session:read with that requestId later to collect it. A desktop command's status also says which computer (computerId) took it.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web instance read transcript status reply answer poll result output check progress desktop command",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id from remote-session:create, from remote-session:read with a desktop commandId, or from remote-session:list." },
        workspaceId: { type: "string", description: "Desktop sessions: the session's workspaceId, when one session id could exist in several workspaces." },
        commandId: { type: "string", description: "Desktop command id returned by remote-session:create. The result includes a session block (status, waitingFor, engine, model, finalText, lastError, messageCount, observedAt) once the desktop reports progress; null until then or for older desktops." },
        requestId: { type: "string", description: "Request id from a pending desktop read, send, or stop result. Returns that result once the desktop answers." },
        messageId: { type: "string", description: "Cloud sessions only: only return this user turn and its assistant replies." },
        from: { type: "string", enum: ["start", "end"], description: "Desktop sessions: page forward from the first message or backward from the latest. Defaults to \"end\"." },
        cursor: { type: "string", description: "Desktop sessions: nextCursor from the previous page, with the same from." },
        limit: { type: "number", description: "Maximum number of messages to return. Defaults to 20, max 100. Desktop pages may hold fewer to stay within 256 KB." },
      },
      oneOf: [{ required: ["sessionId"] }, { required: ["commandId"] }, { required: ["requestId"] }],
    },
  },
  {
    action: "list",
    summary:
      "List the sessions you started on your desktop with remote-session:create target \"desktop\", newest first, with title, sessionId, workspaceId, status, and updatedAt. Use a sessionId with remote-session:read, send, or stop.",
    searchExtraTokens: "remote session sessions list desktop conversations chats started recent history",
    argumentsSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["desktop"] },
        workspaceId: { type: "string", description: "Only sessions in this desktop workspace." },
        limit: { type: "number", description: "Defaults to 20, max 50." },
      },
      required: ["target"],
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

export type RemoteSessionThreadClient = Pick<AgentSessionClient, "createThread" | "sendTurn" | "getThreadSnapshot"> & Partial<Pick<AgentSessionClient, "abortThread">>

/** One of the member's desktops that can take remote sessions, with its latest inventory. */
export type RemoteSessionDesktopRecord = {
  computerId: string
  platform: "darwin" | "win32" | "linux"
  appVersion: string
  lastSeenAt: number
  inventory: DesktopRunnerInventory | null
}

export type RemoteSessionDesktopTargets = {
  ownerMemberId: string | null
  computers: RemoteSessionDesktopRecord[]
}

export type RemoteSessionExecuteDeps = {
  getOpenWorkWebAccess: OpenWorkWebRuntimeAccessResolver
  resolveRuntime: (scope: { organizationId: DenTypeId<"organization">; userId: string; provisionIfMissing?: boolean }) => Promise<RemoteSessionRuntimeResult>
  createClient: (runtime: RemoteSessionRuntime) => RemoteSessionThreadClient
  commandStore: RemoteSessionCommandStore
  desktopPresence: (scope: {
    organizationId: DenTypeId<"organization">
    userId: string
  }) => Promise<{ connected: boolean; ownerMemberId: string | null }>
  requestStore: RemoteSessionRequestStore
  /** Whether the runner that owns a desktop session is connected and can answer requests. */
  desktopRunner: (scope: {
    organizationId: string
    ownerMemberId: string
    runnerId: string
  }) => Promise<{ connected: boolean; controlCapable: boolean }>
  /** How long a desktop request is awaited before returning its requestId. */
  requestWait?: { timeoutMs: number; pollMs: number }
  /**
   * Links a queued desktop command to the run that created it (a Slack thread),
   * so the outcome is posted there. Resolves true when linked.
   */
  linkDesktopCommand?: (input: {
    commandId: string
    organizationId: DenTypeId<"organization">
    userId: string
    runTokenId: string
  }) => Promise<boolean>
  /** The member's desktops and their inventories; defaults to the runner table. */
  desktopTargets?: (scope: {
    organizationId: DenTypeId<"organization">
    userId: string
  }) => Promise<RemoteSessionDesktopTargets>
  /** Whether this deployment can run cloud remote sessions; defaults to the deployment config. */
  cloudAvailable?: () => boolean
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
  "OpenWork Cloud is not available on this deployment; remote sessions targeting Cloud cannot run."

function cloudRemoteSessionsAvailable(): boolean {
  return cloudHostingAvailable({ orgMode: env.orgMode, openworkWebEnabled: env.openworkWebEnabled }) && cloudRuntimeAvailable()
}

export function remoteSessionCapabilitiesEnabled(
  _organizationMetadata?: Record<string, unknown> | string | null | undefined,
): boolean {
  return env.automations.runtimeEnabled || cloudRemoteSessionsAvailable()
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
  if (!cloudRemoteSessionsAvailable()) {
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

async function activeMemberId(scope: {
  organizationId: DenTypeId<"organization">
  userId: string
}): Promise<string | null> {
  const members = await db.select({ id: MemberTable.id }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, scope.organizationId),
    eq(MemberTable.userId, normalizeDenTypeId("user", scope.userId)),
    isNull(MemberTable.removedAt),
  )).limit(1)
  return members[0]?.id ?? null
}

/** Desktops listed by remote-session:targets; a member rarely has more than a few. */
const DESKTOP_TARGET_LIMIT = 50

async function defaultDesktopTargets(scope: {
  organizationId: DenTypeId<"organization">
  userId: string
}): Promise<RemoteSessionDesktopTargets> {
  const ownerMemberId = await activeMemberId(scope)
  if (!ownerMemberId) return { ownerMemberId: null, computers: [] }
  const rows = await automationRepository.listRemoteSessionDesktops({
    organizationId: scope.organizationId,
    ownerMemberId,
    capability: REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
    limit: DESKTOP_TARGET_LIMIT,
  })
  return {
    ownerMemberId,
    computers: rows.map((row) => {
      // Stored reports were validated on the way in; a row that no longer
      // parses (an older shape) reads as a desktop that reported nothing.
      const inventory = row.inventory ? desktopRunnerInventorySchema.safeParse(row.inventory) : null
      return {
        computerId: row.id,
        platform: row.platform,
        appVersion: row.appVersion,
        lastSeenAt: row.lastSeenAt.getTime(),
        inventory: inventory?.success ? inventory.data : null,
      }
    }),
  }
}

async function defaultDesktopPresence(scope: {
  organizationId: DenTypeId<"organization">
  userId: string
}): Promise<{ connected: boolean; ownerMemberId: string | null }> {
  const ownerMemberId = await activeMemberId(scope)
  if (!ownerMemberId) return { connected: false, ownerMemberId: null }
  const lastSeenAt = await automationRepository.desktopRunnerCapabilityLastSeenAt({
    organizationId: scope.organizationId,
    ownerMemberId,
    capability: REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  })
  return { connected: desktopRunnerConnected({ lastSeenAt, now: Date.now() }), ownerMemberId }
}

async function defaultDesktopRunner(scope: {
  organizationId: string
  ownerMemberId: string
  runnerId: string
}): Promise<{ connected: boolean; controlCapable: boolean }> {
  const runner = await automationRepository.desktopRunnerById(scope)
  if (!runner) return { connected: false, controlCapable: false }
  return {
    connected: desktopRunnerConnected({ lastSeenAt: runner.lastSeenAt, now: Date.now() }),
    controlCapable: runner.capabilities.includes(REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY),
  }
}

export const DEFAULT_REMOTE_SESSION_DEPS: RemoteSessionExecuteDeps = {
  getOpenWorkWebAccess: getOpenWorkWebRuntimeAccess,
  resolveRuntime: defaultResolveRuntime,
  createClient: defaultCreateClient,
  commandStore: databaseRemoteSessionCommandStore,
  desktopPresence: defaultDesktopPresence,
  requestStore: databaseRemoteSessionRequestStore,
  desktopRunner: defaultDesktopRunner,
  // Loaded lazily: the Slack module pulls in the assistant repository.
  linkDesktopCommand: async (input) =>
    (await import("../slack-assistant/desktop-handoff.js")).linkDesktopCommandToSlack(input),
  desktopTargets: defaultDesktopTargets,
  cloudAvailable: cloudRemoteSessionsAvailable,
}

const PLATFORM_LABELS: Record<RemoteSessionDesktopRecord["platform"], string> = {
  darwin: "Mac",
  win32: "Windows PC",
  linux: "Linux computer",
}

function desktopOnline(computer: RemoteSessionDesktopRecord, now: number): boolean {
  return desktopRunnerConnected({ lastSeenAt: computer.lastSeenAt, now })
}

function targetsPayload(
  targets: RemoteSessionDesktopTargets,
  options: { includeModels: boolean; cloudAvailable: boolean; now: number },
): Record<string, unknown> {
  return {
    computers: targets.computers.map((computer) => ({
      computerId: computer.computerId,
      kind: "desktop",
      label: computer.inventory?.computer.label ?? PLATFORM_LABELS[computer.platform],
      platform: computer.platform,
      appVersion: computer.inventory?.computer.appVersion ?? computer.appVersion,
      online: desktopOnline(computer, options.now),
      lastSeenAt: computer.lastSeenAt,
      // Null means this desktop has not reported its workspaces (an older
      // app version); it can still take untargeted remote sessions.
      workspaces: computer.inventory
        ? computer.inventory.workspaces.map((workspace) => ({
          workspaceId: workspace.workspaceId,
          name: workspace.name,
          active: workspace.active,
          engine: workspace.engine,
          defaultModel: workspace.defaultModel,
          ...(options.includeModels ? { models: workspace.models } : {}),
        }))
        : null,
    })),
    cloud: { available: options.cloudAvailable },
  }
}

type DesktopTargetResolution =
  | { ok: true; computerId: string; workspaceId: string | null }
  | { ok: false; error: "unknown_computer" | "unknown_workspace" | "computer_offline" | "model_unavailable"; message: string }

const TARGETS_HINT = "Call remote-session:targets to list your computers and workspaces."

/**
 * Checks a desktop create's computerId, workspaceId and model against the
 * member's latest desktop inventories. A workspaceId without a computerId
 * resolves to the most recently seen online desktop that has it.
 */
export function resolveDesktopTarget(
  body: { computerId?: string; workspaceId?: string; model?: { providerId: string; modelId: string } },
  computers: readonly RemoteSessionDesktopRecord[],
  now: number,
): DesktopTargetResolution {
  let computer: RemoteSessionDesktopRecord | undefined
  if (body.computerId !== undefined) {
    computer = computers.find((candidate) => candidate.computerId === body.computerId)
    if (!computer) {
      return { ok: false, error: "unknown_computer", message: `No computer "${body.computerId}" can take remote sessions for your account. ${TARGETS_HINT}` }
    }
    if (!desktopOnline(computer, now)) {
      return { ok: false, error: "computer_offline", message: "That computer is not connected. Open the OpenWork desktop app on it, or choose another computer." }
    }
  } else if (body.workspaceId !== undefined) {
    const having = computers.filter((candidate) => candidate.inventory?.workspaces
      .some((workspace) => workspace.workspaceId === body.workspaceId))
    computer = having.find((candidate) => desktopOnline(candidate, now))
    if (!computer && having.length > 0) {
      return { ok: false, error: "computer_offline", message: "The computer with that workspace is not connected. Open the OpenWork desktop app on it, or choose another workspace." }
    }
  }
  if (!computer) {
    return { ok: false, error: "unknown_workspace", message: `No workspace "${body.workspaceId ?? ""}" is reported by your computers. ${TARGETS_HINT}` }
  }

  const workspaces = computer.inventory?.workspaces ?? []
  const workspace = body.workspaceId === undefined
    ? workspaces.find((candidate) => candidate.active) ?? workspaces[0]
    : workspaces.find((candidate) => candidate.workspaceId === body.workspaceId)
  if (body.workspaceId !== undefined && !workspace) {
    return { ok: false, error: "unknown_workspace", message: `That computer does not report a workspace "${body.workspaceId}". ${TARGETS_HINT}` }
  }
  const model = body.model
  if (model && workspace && workspace.models.length > 0
    && !workspace.models.some((candidate) => candidate.providerId === model.providerId && candidate.modelId === model.modelId)) {
    return {
      ok: false,
      error: "model_unavailable",
      message: `Model ${model.providerId}/${model.modelId} is not available in workspace "${workspace.name}". Call remote-session:targets with includeModels true to list its models.`,
    }
  }
  return { ok: true, computerId: computer.computerId, workspaceId: body.workspaceId ?? null }
}

const DESKTOP_REQUEST_WAIT = { timeoutMs: 20_000, pollMs: 500 }

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

function desktopRequestResult(request: RemoteSessionRequest): RemoteSessionToolResult {
  const identity = {
    target: "desktop",
    requestId: request.id,
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
  }
  if (request.status === "pending" || request.status === "claimed") {
    return jsonResult({
      ...identity,
      action: request.action,
      state: "pending",
      note: "The desktop has not answered yet. Call remote-session:read with this requestId to collect the result.",
    })
  }
  if (request.status === "expired") {
    return errorResult({
      ...identity,
      action: request.action,
      error: "desktop_request_expired",
      message: "The desktop did not answer in time. Make sure OpenWork is open on that computer, then try again.",
      retryable: true,
    })
  }
  if (request.status === "failed" || !request.outcome) {
    const error = request.error ?? { code: "desktop_request_failed", message: "The desktop could not complete the request." }
    return errorResult({
      ...identity,
      action: request.action,
      error: error.code,
      message: error.message,
      retryable: error.code !== "unknown_session" && error.code !== "invalid_cursor",
    })
  }
  const outcome = request.outcome
  if (outcome.action === "read") {
    return jsonResult({ ...identity, state: "done", ...outcome.result })
  }
  if (outcome.action === "send") {
    return jsonResult({
      ...identity,
      commandId: request.commandId,
      state: "accepted",
      messageId: outcome.result.messageId,
      alreadyPresent: outcome.result.alreadyPresent,
      note: "The prompt was accepted on the desktop. Poll remote-session:read with commandId until session.status settles, or with sessionId for the transcript.",
    })
  }
  return jsonResult({ ...identity, stopped: outcome.result.stopped, reason: outcome.result.reason })
}

function bodySessionLocation(body: unknown): { sessionId: string; workspaceId?: string } | null {
  if (!isRecord(body) || typeof body.sessionId !== "string" || !body.sessionId) return null
  return {
    sessionId: body.sessionId,
    ...(typeof body.workspaceId === "string" && body.workspaceId ? { workspaceId: body.workspaceId } : {}),
  }
}

/**
 * A session created through a desktop command belongs to the runner that
 * delivered it. Anything else keeps the Cloud path unchanged.
 */
async function findDesktopSession(
  input: RemoteSessionExecuteInput,
  body: unknown,
  deps: RemoteSessionExecuteDeps,
): Promise<RemoteSessionDesktopSession | null> {
  if (!env.automations.runtimeEnabled) return null
  const location = bodySessionLocation(body)
  if (!location) return null
  return deps.commandStore.findDesktopSession({
    organizationId: input.organizationId,
    createdByUserId: input.userId,
    ...location,
  })
}

function desktopRequestInput(action: "read" | "send" | "stop", body: unknown): RemoteSessionRequestInput {
  if (action === "read") {
    const read = readBodySchema.parse(body)
    return {
      action: "read",
      input: { from: read.from ?? "end", cursor: read.cursor ?? null, limit: read.limit ?? READ_DEFAULT_MESSAGE_LIMIT },
    }
  }
  if (action === "send") {
    const send = sendBodySchema.parse(body)
    return {
      action: "send",
      input: {
        prompt: send.prompt,
        messageId: send.messageId ?? null,
        model: send.model
          ? { providerId: send.model.providerId, modelId: send.model.modelId, variant: send.model.variant ?? null }
          : null,
      },
    }
  }
  const stop = stopBodySchema.parse(body)
  return { action: "stop", input: { messageId: stop.messageId ?? null } }
}

async function executeDesktopSessionAction(
  input: RemoteSessionExecuteInput,
  body: unknown,
  session: RemoteSessionDesktopSession,
  deps: RemoteSessionExecuteDeps,
): Promise<RemoteSessionToolResult> {
  if (input.action !== "read" && input.action !== "send" && input.action !== "stop") {
    throw new Error("remote_session_desktop_action_invariant")
  }
  const runner = await deps.desktopRunner({
    organizationId: input.organizationId,
    ownerMemberId: session.ownerMemberId,
    runnerId: session.runnerId,
  })
  if (!runner.controlCapable) {
    return errorResult({
      target: "desktop",
      sessionId: session.sessionId,
      error: "desktop_update_required",
      message: "The desktop that runs this session needs an OpenWork update before it can be read, followed up, or stopped remotely. remote-session:read with its commandId still reports status and the final answer.",
      commandId: session.commandId,
      retryable: false,
    })
  }
  if (!runner.connected) {
    return errorResult({
      target: "desktop",
      sessionId: session.sessionId,
      error: "desktop_offline",
      message: "The desktop that runs this session is not connected. Open OpenWork on that computer and try again.",
      retryable: true,
    })
  }
  const request = await deps.requestStore.enqueue({
    ...desktopRequestInput(input.action, body),
    organizationId: input.organizationId,
    ownerMemberId: session.ownerMemberId,
    createdByUserId: input.userId,
    commandId: session.commandId,
    targetRunnerId: session.runnerId,
    workspaceId: session.workspaceId,
    sessionId: session.sessionId,
    engine: session.engine,
    ttlMs: REMOTE_SESSION_REQUEST_TTL_MS,
  })
  const wait = deps.requestWait ?? DESKTOP_REQUEST_WAIT
  const deadline = Date.now() + wait.timeoutMs
  let current = request
  while (current.status === "pending" || current.status === "claimed") {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(wait.pollMs, remaining))
    const next = await deps.requestStore.get({
      requestId: request.id,
      organizationId: input.organizationId,
      createdByUserId: input.userId,
    })
    if (!next) break
    current = next
  }
  return desktopRequestResult(current)
}

export type RemoteSessionExecuteInput = {
  action: RemoteSessionAction
  organizationId: DenTypeId<"organization">
  userId: string
  hasWriteScope: boolean
  body: unknown
  /** Set when the call is made with a headless-run token Den minted (for example for a Slack run). */
  headlessRunTokenId?: string | null
}

/** Added to a desktop create that a Slack run made: Den posts the outcome there, so the run should not wait. */
const postedInThreadFields = {
  resultPostedInThread: true,
  note: "OpenWork will post the result in this Slack thread when the desktop finishes, fails, or needs approval. Tell the person that, then end your turn; for status questions later, use remote-session:read with this commandId.",
}

/** Never fails the create: the command is already queued, only the thread report is lost. */
async function linkToOriginatingRun(
  deps: RemoteSessionExecuteDeps,
  input: RemoteSessionExecuteInput,
  commandId: string,
  hasPrompt: boolean,
) {
  if (!hasPrompt || !input.headlessRunTokenId || !deps.linkDesktopCommand) return false
  try {
    return await deps.linkDesktopCommand({
      commandId,
      organizationId: input.organizationId,
      userId: input.userId,
      runTokenId: input.headlessRunTokenId,
    })
  } catch (error) {
    appLogger.warn("remote_session_desktop_link_failed", { command_id: commandId, error })
    return false
  }
}

export async function executeRemoteSessionCapability(
  input: RemoteSessionExecuteInput,
  deps: RemoteSessionExecuteDeps = DEFAULT_REMOTE_SESSION_DEPS,
): Promise<RemoteSessionToolResult> {
  if ((input.action === "create" || input.action === "send" || input.action === "stop") && !input.hasWriteScope) {
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

  if (input.action === "list") {
    const body = listBodySchema.parse(parsedBody.data)
    const sessions = await deps.commandStore.listDesktopSessions({
      organizationId: input.organizationId,
      createdByUserId: input.userId,
      ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
      limit: body.limit ?? LIST_DEFAULT_LIMIT,
    })
    return jsonResult({
      target: "desktop",
      sessions: sessions.map((session) => ({
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        commandId: session.commandId,
        title: session.title,
        // Null until the desktop first reports progress (older desktops never do).
        status: session.status,
        updatedAt: session.updatedAt,
      })),
    })
  }

  if (input.action === "read") {
    const body = readBodySchema.parse(parsedBody.data)
    if (body.requestId) {
      const request = await deps.requestStore.get({
        requestId: body.requestId,
        organizationId: input.organizationId,
        createdByUserId: input.userId,
      })
      if (!request) return errorResult({ error: "unknown_request", retryable: false })
      return desktopRequestResult(request)
    }
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
        // The computer that took the command, or the one it waits for.
        computerId: command.claimedByRunnerId
          ? automationRunnerRowId({
            organizationId: command.organizationId,
            ownerMemberId: command.ownerMemberId,
            runnerId: command.claimedByRunnerId,
          })
          : command.targetComputerId,
        sessionId: command.sessionId,
        workspaceId: command.workspaceId,
        resultSummary: command.resultSummary,
        error: command.error,
        expiresAt: command.expiresAt,
        session: command.session,
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

  if (input.action === "read" || input.action === "send" || input.action === "stop") {
    const desktopSession = await findDesktopSession(input, parsedBody.data, deps)
    if (desktopSession) return executeDesktopSessionAction(input, parsedBody.data, desktopSession, deps)
  }

  if (input.action === "targets") {
    const body = targetsBodySchema.parse(parsedBody.data)
    const targets = env.automations.runtimeEnabled
      ? await (deps.desktopTargets ?? defaultDesktopTargets)({ organizationId: input.organizationId, userId: input.userId })
      : { ownerMemberId: null, computers: [] }
    return jsonResult(targetsPayload(targets, {
      includeModels: body.includeModels === true,
      cloudAvailable: (deps.cloudAvailable ?? cloudRemoteSessionsAvailable)(),
      now: Date.now(),
    }))
  }

  if (input.action === "create") {
    const body = createBodySchema.parse(parsedBody.data)
    if (body.target === "desktop" && (body.computerId !== undefined || body.workspaceId !== undefined)) {
      const targets = env.automations.runtimeEnabled
        ? await (deps.desktopTargets ?? defaultDesktopTargets)({ organizationId: input.organizationId, userId: input.userId })
        : { ownerMemberId: null, computers: [] }
      if (!targets.ownerMemberId || targets.computers.length === 0) {
        return errorResult({
          error: "desktop_offline",
          message: "No desktop is connected for your account. Open the OpenWork desktop app and try again.",
        })
      }
      const resolved = resolveDesktopTarget(body, targets.computers, Date.now())
      if (!resolved.ok) return errorResult({ error: resolved.error, message: resolved.message, retryable: false })
      const command = await deps.commandStore.enqueue({
        organizationId: input.organizationId,
        ownerMemberId: targets.ownerMemberId,
        createdByUserId: input.userId,
        title: body.title ?? "Remote session",
        ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ttlMs: DEFAULT_TTL_MS,
        idempotencyKey: createDenTypeId("remoteSessionCommand"),
        targetComputerId: resolved.computerId,
        ...(resolved.workspaceId === null ? {} : { targetWorkspaceId: resolved.workspaceId }),
      })
      // A Slack run that picked a computer hands off the same way as one that didn't: the result is posted to
      // its thread, so the run can end instead of waiting for the desktop.
      const postsToThread = await linkToOriginatingRun(deps, input, command.id, body.prompt !== undefined)
      return jsonResult({
        target: "desktop",
        state: "queued",
        commandId: command.id,
        computerId: resolved.computerId,
        workspaceId: resolved.workspaceId,
        expiresAt: command.expiresAt,
        ...(postsToThread ? postedInThreadFields : {}),
      })
    }
    if (body.target === "desktop") {
      const presence = env.automations.runtimeEnabled
        ? await deps.desktopPresence({ organizationId: input.organizationId, userId: input.userId })
        : { connected: false, ownerMemberId: null }
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
      const postsToThread = await linkToOriginatingRun(deps, input, command.id, body.prompt !== undefined)
      return jsonResult({
        target: "desktop",
        state: "queued",
        commandId: command.id,
        expiresAt: command.expiresAt,
        ...(postsToThread ? postedInThreadFields : {}),
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

  if (input.action === "stop") {
    const body = stopBodySchema.parse(parsedBody.data)
    try {
      if (!client.abortThread) return errorResult({ error: "stop_unavailable", retryable: false })
      if (body.messageId) {
        const snapshot = await client.getThreadSnapshot(body.sessionId)
        const currentTurn = snapshot.messages.slice().reverse().find(message => message.role === "user")
        if (currentTurn?.id !== body.messageId) {
          return jsonResult({ sessionId: body.sessionId, stopped: false, reason: "different_turn" })
        }
      }
      const result = await client.abortThread(body.sessionId)
      return jsonResult({ sessionId: body.sessionId, ...result })
    } catch (error) {
      return threadErrorResult("stop", body.sessionId, error)
    }
  }

  if (input.action === "send") {
    const body = sendBodySchema.parse(parsedBody.data)
    try {
      const accepted = await client.sendTurn(body.sessionId, {
        prompt: body.prompt,
        ...(body.messageId ? { messageId: body.messageId } : {}),
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

  if (input.action !== "read") throw new Error("remote_session_action_invariant")
  const body = readBodySchema.parse(parsedBody.data)
  if (!body.sessionId) throw new Error("remote_session_read_body_invariant")
  try {
    const snapshot = await client.getThreadSnapshot(body.sessionId)
    const currentMessages = body.messageId
      ? snapshot.messages.filter(message => message.id === body.messageId || message.parentId === body.messageId)
      : snapshot.messages
    const transcript = toTranscript({ ...snapshot, messages: currentMessages })
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
        toolCalls: message.toolCalls.map((tool) => ({ id: tool.partId, name: tool.name, status: tool.status })),
      })),
      finalAssistantText: body.messageId
        ? transcript.messages.filter(message => message.role === "assistant" && message.text).map(message => message.text).join("\n\n").slice(0, 100_000)
        : transcript.finalAssistantText.slice(0, FINAL_TEXT_LIMIT),
      ...(transcript.terminalError ? { terminalError: transcript.terminalError } : {}),
    })
  } catch (error) {
    return threadErrorResult("read", body.sessionId, error)
  }
}
