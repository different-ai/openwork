import { and, desc, eq } from "@openwork-ee/den-db/drizzle"
import { CloudCodingPullRequestTable as PullRequests, CloudCodingPushApprovalTable as Approvals } from "@openwork-ee/den-db/schema"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import { CLOUD_CODING_CONNECTION_ID, CLOUD_CODING_CONNECTION_NAME, cloudCodingTestReportSchema, type CloudCodingReadiness } from "@openwork/types/den/cloud-coding"
import { z } from "zod"
import { AuditUnavailableError, auditUnavailableToolResult, runMcpServiceAction, toolResultStatus } from "../../audit/mcp-service-audit.js"
import { appendAuditChanges, type AuditChangeCapture } from "../../audit/request-capture.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { markFeaturesUsed } from "../../feature-usage.js"
import { organizationFeatureEnabled } from "../../features.js"
import { eventThreadForPrincipal } from "../../mcp-events/context.js"
import { unknownCapabilityResult, type CapabilityRegistryContext, type CapabilitySource, type ExecuteCapabilityToolResult } from "../../mcp/capability-registry.js"
import { connectionActionAppMeta, connectionActionPayloadFromStatus } from "../../mcp/connection-action.js"
import type { ExternalConnectionStatus } from "../../mcp/external-capabilities.js"
import { headlessRunTokenId } from "../../mcp/headless-run-token.js"
import { executeRemoteSessionCapability } from "../../mcp/remote-session-capabilities.js"
import { DEN_MCP_WRITE_SCOPE } from "../../mcp/scopes.js"
import { scoreText, tokenize, type CapabilityMatch } from "../../mcp/search.js"
import { LIMITED_AGENT_RUN_MESSAGE } from "../../mcp/workbot-turn-limits.js"
import { getCloudCodingReadiness } from "../access.js"
import { findCloudCodingRepository, listCloudCodingRepositories, readInstalledRepository } from "../installation.js"
import { createCloudCodingTask, findCloudCodingTask, renewCloudCodingSetupCode, updateCloudCodingTask, type CloudCodingTaskRow } from "../tasks.js"
import { buildCloudCodingKickoffPrompt } from "./kickoff-prompt.js"

const statusArgs = z.strictObject({ taskId: z.string().trim().min(1).max(64).describe("Task ID returned by cloud-coding:start.") })
const startArgs = z.strictObject({
  repository: z.string().trim().min(1).max(255).describe("GitHub repository as owner/name or an unambiguous short name."),
  task: z.string().min(1).max(8000).refine((value) => value.trim().length > 0).describe("What to change, in the person's words, plus any useful detail."),
  baseBranch: z.string().trim().min(1).max(255).optional().describe("Branch to start from. Defaults to the repository's current default branch."),
  title: z.string().trim().min(1).max(120).optional().describe("Short title for the task. Defaults to a title derived from the request."),
  taskId: statusArgs.shape.taskId.optional().describe("Only pass this when retrying a start that said the cloud computer was still starting. Keep all other arguments the same."),
})
const repositoriesArgs = z.strictObject({})

const definitions = {
  start: {
    args: startArgs,
    summary: "Make a code change on a cloud computer: fix a bug or add code in a GitHub repository, run tests, then ask the person to approve pushing a new branch and opening a pull request. Requires write access.",
    result: "Returns ok, taskId, sessionId, repository, baseBranch, status and a progress note. A still-starting error returns taskId to retry; a GitHub connection error tells the person how to connect. A running task does not mean a pull request has opened.",
    aliases: "code coding bug fix repository repo GitHub pull request PR branch commit change code open a PR",
  },
  status: {
    args: statusArgs,
    summary: "Check the person's own Cloud coding task for progress, the push approval, or the GitHub pull request link.",
    result: "Returns taskId, repository, baseBranch, status, sessionId (or null), approval (id, status, branch, headSha, fileCount, tests, approvalUrl) or null, pullRequest (number, url, state) or null, and a note about what to tell the person.",
    aliases: "progress check follow status",
  },
  repositories: {
    args: repositoriesArgs,
    summary: "List GitHub repositories the person's organization has selected for Cloud coding. Takes no arguments.",
    result: "Returns repositories with fullName, defaultBranch (or null), and private (true or false), or tells the person what they need to set up first.",
    aliases: "list repositories repos available",
  },
}

const actionSchema = z.enum(["start", "status", "repositories"])
type Action = z.infer<typeof actionSchema>
type Scope = Parameters<typeof getCloudCodingReadiness>[0]

const runtimeSuccess = z.object({ sessionId: z.string().min(1), workerId: z.string().min(1), workspaceId: z.string().min(1), started: z.literal(true) })
const runtimeError = z.object({ error: z.string().regex(/^[a-z][a-z_]{0,63}$/), message: z.string(), retryable: z.boolean().optional(), retryAfterMs: z.number().nonnegative().optional() })
const cloudCodingUrl = `${env.webUrl.replace(/\/+$/, "")}/dashboard/cloud-coding`
let startCloudSession = executeRemoteSessionCapability

export function setCloudCodingSessionStarterForTests(starter: typeof executeRemoteSessionCapability | undefined): void {
  startCloudSession = starter ?? executeRemoteSessionCapability
}

function output(payload: Record<string, unknown>, isError = false): ExecuteCapabilityToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function failure(error: string, message: string, extra?: Record<string, unknown>): ExecuteCapabilityToolResult {
  return output({ ok: false, error, message, retryable: false, ...extra }, true)
}

const readinessMessages: Record<Exclude<CloudCodingReadiness, "ready">, string> = {
  feature_disabled: "Cloud coding is not available.",
  not_configured: "Cloud coding isn't set up on this deployment yet.",
  github_not_connected: "GitHub isn't connected for your organization yet. An admin can connect it from Cloud coding in OpenWork.",
  turned_off: "Cloud coding is turned off for your organization. An admin can turn it on from Cloud coding in OpenWork.",
  not_allowed: "You're not included in Cloud coding yet. Ask an admin to add you.",
  github_suspended: "GitHub paused OpenWork's access. An admin can resume it on GitHub.",
  account_not_linked: "Link your GitHub account so the pull request opens in your name.",
}

function readinessError(reason: Exclude<CloudCodingReadiness, "ready">): ExecuteCapabilityToolResult {
  const message = readinessMessages[reason]
  if (reason !== "github_not_connected" && reason !== "account_not_linked") return failure(reason, message)
  const personal = reason === "account_not_linked"
  const url = personal ? `${cloudCodingUrl}/link` : cloudCodingUrl
  const connectionStatus: ExternalConnectionStatus = {
    version: 1, kind: "connection_action", source: "openwork-cloud", layer: "mcp_connection", errorCode: "not_connected",
    connectionId: CLOUD_CODING_CONNECTION_ID, connectionName: CLOUD_CODING_CONNECTION_NAME, authType: "oauth",
    credentialMode: personal ? "per_member" : "shared", state: "needs_connection", actor: personal ? "member" : "organization_admin",
    action: { type: "connect", label: "Connect GitHub", surface: personal ? "openwork_your_connections" : "openwork_organization_connections", retry: "search_capabilities", url },
    message,
  }
  const result = output({ ok: false, error: reason, message, connectionStatus, ...(personal
    ? { linkUrl: url, note: 'In OpenWork chats, use the native connection question for "GitHub", then call cloud-coding:start again with the same arguments. Elsewhere, give the person linkUrl.' }
    : { setupUrl: url }) }, true)
  return { ...result, structuredContent: connectionActionPayloadFromStatus(connectionStatus), _meta: connectionActionAppMeta(connectionStatus.connectionId) }
}

function taskNotFound() {
  return failure("task_not_found", "This Cloud coding task couldn't be found.")
}

function findTask(scope: Scope, taskId: string) {
  return isDenTypeId("cloudCodingTask", taskId) ? findCloudCodingTask({ ...scope, taskId }) : Promise.resolve(null)
}

const taskNotes: Record<CloudCodingTaskRow["status"], string> = {
  created: "The cloud computer is still starting.",
  running: "The work is running on a cloud computer. No pull request has opened yet.",
  awaiting_approval: "The change is waiting for the person's approval. No pull request has opened yet.",
  pushed: "The branch was pushed. No pull request has opened yet.",
  pull_request_opened: "Check again shortly for the pull request link.",
  failed: "The task couldn't finish. No pull request link is available.",
  cancelled: "The task was cancelled. No pull request link is available.",
}

function taskProgress(task: CloudCodingTaskRow) {
  return {
    taskId: task.id, repository: task.repositoryFullName, baseBranch: task.baseBranch,
    status: task.status === "created" && task.remoteSessionId ? "running" : task.status,
    sessionId: task.remoteSessionId,
  } as const
}

async function taskStatus(task: CloudCodingTaskRow) {
  const [row] = await db.$primary.select({
    id: Approvals.id, status: Approvals.status, branch: Approvals.branch, headSha: Approvals.headSha, summary: Approvals.summary, expiresAt: Approvals.expiresAt,
    number: PullRequests.number, url: PullRequests.url, state: PullRequests.state,
  }).from(Approvals).leftJoin(PullRequests, and(
    eq(PullRequests.approvalId, Approvals.id), eq(PullRequests.organizationId, Approvals.organizationId),
    eq(PullRequests.taskId, Approvals.taskId), eq(PullRequests.openedByOrgMembershipId, Approvals.orgMembershipId),
  )).where(and(
    eq(Approvals.taskId, task.id), eq(Approvals.organizationId, task.organizationId), eq(Approvals.orgMembershipId, task.orgMembershipId),
  )).orderBy(desc(Approvals.createdAt), desc(Approvals.id)).limit(1)
  const approval = row ? {
    id: row.id, status: (row.status === "pending" || row.status === "approved") && row.expiresAt.getTime() <= Date.now() ? "expired" : row.status,
    branch: row.branch, headSha: row.headSha, fileCount: row.summary.fileCount,
    tests: cloudCodingTestReportSchema.parse(row.summary.tests), approvalUrl: `${cloudCodingUrl}/approvals/${row.id}`,
  } : null
  const pullRequest = row?.number && row.url && row.state ? { number: row.number, url: row.url, state: row.state } : null
  const progress = taskProgress(task)
  const note = pullRequest ? `A pull request was opened. Share this link: ${pullRequest.url}`
    : approval?.status === "pending" ? `The push is waiting for the person's approval. They can decide in their OpenWork chat or at ${approval.approvalUrl}.`
    : approval?.status === "denied" ? "The push was denied. Nothing was pushed."
    : approval?.status === "expired" ? "The approval expired. Nothing was pushed."
    : approval?.status === "approved" ? "The push was approved. No pull request has opened yet."
    : taskNotes[progress.status]
  return output({ ...progress, approval, pullRequest, note })
}

async function repositoryUnavailable(organizationId: Scope["organizationId"], unavailableId?: number) {
  const names = (await listCloudCodingRepositories(organizationId)).filter((row) => row.githubRepositoryId !== unavailableId).slice(0, 10).map((row) => row.fullName)
  const choices = names.length ? ` Available repositories include: ${names.join(", ")}.` : " No other repositories are listed."
  return failure("repository_not_available", `That repository isn't available for Cloud coding.${choices} An admin chooses repositories on GitHub.`)
}

const runningNote = "The work now runs on a cloud computer. The person will be asked to approve the push in their OpenWork chat; on other surfaces give them the approvalUrl from cloud-coding:status when it's available. Follow progress with remote-session:status for sessionId and cloud-coding:status for taskId. Never say a pull request is open until cloud-coding:status shows it."
const startingNote = "Your cloud computer is still starting. Call cloud-coding:start again with this taskId in about 30 seconds."

async function startTask(ctx: CapabilityRegistryContext, scope: Scope, args: z.infer<typeof startArgs>, personName: string, capture: AuditChangeCapture | null): Promise<ExecuteCapabilityToolResult> {
  const existing = args.taskId === undefined ? null : await findTask(scope, args.taskId)
  if (args.taskId !== undefined && !existing) return taskNotFound()
  const repository = await findCloudCodingRepository({ organizationId: scope.organizationId, fullName: args.repository })
  if (!repository) return repositoryUnavailable(scope.organizationId)
  if (existing && (existing.githubRepositoryId !== repository.githubRepositoryId || (args.baseBranch && args.baseBranch !== existing.baseBranch))) return taskNotFound()
  if (existing && (existing.status !== "created" || existing.remoteSessionId)) return taskStatus(existing)
  const live = await readInstalledRepository({ organizationId: scope.organizationId, githubRepositoryId: repository.githubRepositoryId })
  if (!live || live.archived) return repositoryUnavailable(scope.organizationId, repository.githubRepositoryId)

  const hostedThread = await eventThreadForPrincipal(ctx.principal).catch(() => null)
  const prepared = existing ? { task: existing, setupCode: await renewCloudCodingSetupCode({ ...scope, taskId: existing.id }) } : await createCloudCodingTask({
    ...scope, repository: { ...repository, fullName: live.fullName }, baseBranch: args.baseBranch ?? live.defaultBranch,
    title: args.title ?? args.task.trim().replace(/\s+/g, " ").slice(0, 120).trimEnd(),
  })
  const { task, setupCode } = prepared
  if (!setupCode) {
    const current = await findTask(scope, task.id)
    return current ? taskStatus(current) : taskNotFound()
  }
  const prompt = buildCloudCodingKickoffPrompt({
    apiBaseUrl: ctx.redirectUriBase, setupCode, repositoryFullName: live.fullName, baseBranch: task.baseBranch, task: args.task, personName,
  })
  const session = await startCloudSession({
    action: "create", organizationId: scope.organizationId, userId: scope.userId, hasWriteScope: true,
    body: { target: "cloud", title: `Code change: ${live.fullName}`.slice(0, 120), prompt },
    headlessRunTokenId: headlessRunTokenId(ctx.principal.payload),
    ...(hostedThread ? { originSessionId: hostedThread.sessionId } : {}),
  }).catch(() => null)
  const success = runtimeSuccess.safeParse(session?.structuredContent)
  if (session && !session.isError && success.success) {
    const { sessionId, workerId } = success.data
    await updateCloudCodingTask(task.id, { remoteSessionId: sessionId, workerId })
    if (capture) await db.transaction((tx) => appendAuditChanges(tx, capture, [{
      action: "cloud_coding.task.started",
      resources: [
        { type: "cloud_coding_task", id: task.id, relationship: "target" },
        { type: "github_repository", id: live.fullName, relationship: "parent" },
        { type: "git_branch", id: task.baseBranch, relationship: "related" },
      ],
    }]))
    return output({ ok: true, taskId: task.id, sessionId, repository: live.fullName, baseBranch: task.baseBranch, status: "running", note: runningNote })
  }
  const remoteError = runtimeError.safeParse(session?.structuredContent)
  if (remoteError.success && remoteError.data.retryable && (remoteError.data.error === "cloud_runtime_provisioning" || remoteError.data.error === "cloud_runtime_waking")) {
    const { message, ...error } = remoteError.data
    return output({ ok: false, ...error, message: message.replaceAll(setupCode, "[redacted]"), taskId: task.id, note: startingNote }, true)
  }
  const code = remoteError.success ? remoteError.data.error : "cloud_session_start_failed"
  await updateCloudCodingTask(task.id, { status: "failed", failureCode: code })
  const message = code === "cloud_not_available" ? "A cloud computer isn't available for your organization."
    : code === "openwork_web_access_required" ? "You need access to OpenWork Web to start a cloud computer. Ask an admin for access."
    : "OpenWork couldn't start the code change on your cloud computer."
  return failure(code, message, { taskId: task.id })
}

async function available(ctx: CapabilityRegistryContext) {
  return ctx.member !== null && await organizationFeatureEnabled(ctx.organizationId, "cloudCoding", { userId: ctx.principal.userId })
}

export const cloudCodingSource: CapabilitySource = {
  kind: "cloudCoding",
  parseName: (name) => {
    if (!name.startsWith("cloud-coding:")) return null
    const action = actionSchema.safeParse(name.slice("cloud-coding:".length))
    return action.success ? { kind: "cloudCoding", name, action: action.data } : null
  },
  search: async (ctx, query, limit) => {
    const tokens = tokenize(query)
    if (!(ctx.sourceFilter.api || ctx.sourceFilter.mcp) || tokens.length === 0 || !await available(ctx)) return []
    const scoreStart = scoreText(tokenize(`cloud-coding:start ${definitions.start.aliases}`), tokenize(definitions.start.summary), tokens)
    const readiness = ctx.member && scoreStart === 0 ? await getCloudCodingReadiness({
      organizationId: ctx.organizationId, memberId: ctx.member.orgMembershipId, userId: ctx.principal.userId,
    }) : null
    const repositoryTokens = readiness?.readiness === "ready"
      ? (await listCloudCodingRepositories(ctx.organizationId)).flatMap(({ fullName }) => tokenize(fullName)) : []
    return actionSchema.options.flatMap((action): CapabilityMatch[] => {
      const { args, summary, result, aliases } = definitions[action]
      const name = `cloud-coding:${action}`
      const score = scoreText(tokenize(`${name} ${aliases}`), tokenize(summary), tokens, repositoryTokens)
        + (query.trim().toLowerCase() === name ? 100 : 0)
      if (score <= 0) return []
      return [{ name, method: "CLOUD", path: name, pathParams: [], queryParams: [], hasBody: action !== "repositories", summary,
        score, argumentsSchema: z.toJSONSchema(args, { io: "input" }), outputSchema: { type: "object", description: result },
        invocation: { argumentsField: "body" }, readOnly: action !== "start", kind: "cloud_coding" }]
    }).sort((a, b) => b.score - a.score).slice(0, limit)
  },
  enumerate: () => Promise.resolve([]),
  execute: async (ctx, parsed, input) => {
    if (parsed.kind !== "cloudCoding" || !ctx.member || !await available(ctx)) return unknownCapabilityResult(input.name)
    const scope = { organizationId: ctx.organizationId, memberId: ctx.member.orgMembershipId, userId: ctx.principal.userId }
    const action: Action = parsed.action
    if (action === "start") {
      if (ctx.limitedAgentRun) return failure("policy_blocked", LIMITED_AGENT_RUN_MESSAGE)
      if (input.requireReadOnly) return failure("policy_blocked", "Starting a code change isn't a read-only action.")
      if (!ctx.principal.scopes.has(DEN_MCP_WRITE_SCOPE)) return failure("insufficient_mcp_scope", "Starting a code change requires write access.", { requiredScope: DEN_MCP_WRITE_SCOPE })
    }
    markFeaturesUsed({ organizationId: scope.organizationId, memberId: scope.memberId, keys: ["cloudCoding"] })
    const body = input.body ?? {}
    if (action === "status") {
      const args = statusArgs.safeParse(body)
      if (!args.success) return failure("invalid_capability_arguments", "Include the task ID returned when the code change started.")
      const task = await findTask(scope, args.data.taskId)
      return task ? taskStatus(task) : taskNotFound()
    }
    if (action === "repositories" && !repositoriesArgs.safeParse(body).success) return failure("invalid_capability_arguments", "Listing repositories takes no arguments.")
    const readiness = await getCloudCodingReadiness(scope)
    if (readiness.readiness === "feature_disabled") return unknownCapabilityResult(input.name)
    if (readiness.readiness !== "ready") return readinessError(readiness.readiness)
    if (action === "repositories") {
      const repositories = (await listCloudCodingRepositories(scope.organizationId)).map(({ fullName, defaultBranch, isPrivate }) => ({ fullName, defaultBranch, private: isPrivate }))
      return output({ repositories })
    }
    const args = startArgs.safeParse(body)
    if (!args.success) return failure("invalid_capability_arguments", "Enter the repository name and describe the code change in 1 to 8,000 characters.")
    const run = (capture: AuditChangeCapture | null) => startTask(ctx, scope, args.data, readiness.link.authorName, capture)
    try {
      return ctx.audit ? await runMcpServiceAction("cloud_coding.task.start", ctx.audit, null, run, { result: toolResultStatus }) : run(null)
    } catch (error) {
      if (error instanceof AuditUnavailableError) return auditUnavailableToolResult()
      throw error
    }
  },
}
