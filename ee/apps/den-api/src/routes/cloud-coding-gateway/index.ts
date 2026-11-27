import { CLOUD_CODING_GATEWAY_REFUSALS, CLOUD_CODING_MAX_TOTAL_BYTES, cloudCodingGatewaySetupInputSchema, cloudCodingGatewaySetupSchema, cloudCodingGatewayTaskSchema, cloudCodingOpenedPullRequestSchema, cloudCodingOpenPullRequestInputSchema, cloudCodingPushApprovalSchema, cloudCodingPushInputSchema, cloudCodingPushRequestSchema, cloudCodingPushResultSchema, cloudCodingReadTokenSchema, type CloudCodingGatewayRefusal } from "@openwork/types/den/cloud-coding"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { addAuditRequestResource, attributeAuditRequest, auditChangeCapture, auditUserPrincipalKey } from "../../audit/request-capture.js"
import { recordGatewayEvent } from "../../cloud-coding/gateway/audit.js"
import { githubRefused } from "../../cloud-coding/gateway/github-git.js"
import { CloudCodingChangeRefusal } from "../../cloud-coding/gateway/git-objects.js"
import { findGatewayTask, gatewayTaskView, issueGatewayReadToken, openGatewayPullRequest, pollGatewayPush, prepareGatewayTask, pushGatewayCommit, requestGatewayPush, requireGatewayApproval, requireGatewayMember } from "../../cloud-coding/gateway/service.js"
import { CloudCodingGithubError } from "../../cloud-coding/github-api.js"
import { redeemCloudCodingSetupCode, type CloudCodingTaskRow } from "../../cloud-coding/tasks.js"
import { db } from "../../db.js"
import { tokenRoute } from "../../middleware/index.js"
import { jsonResponse } from "../../openapi.js"

const root = "/v1/cloud-coding/gateway"
const errorSchema = z.object({ error: z.enum(CLOUD_CODING_GATEWAY_REFUSALS), message: z.string() })
const approvalEnvelope = z.object({ approval: cloudCodingPushApprovalSchema })
const statuses = {
  task_closed: 401, approval_not_found: 404, feature_disabled: 403, turned_off: 403, not_allowed: 403, github_not_connected: 403,
  github_suspended: 403, account_not_linked: 403, repository_not_available: 403, approval_pending: 409, approval_denied: 409,
  approval_expired: 409, approval_used: 409, branch_exists: 409, default_branch_refused: 409, invalid_branch: 422, base_not_found: 422,
  workflow_files_refused: 422, path_refused: 422, file_mode_refused: 422, change_too_large: 422, no_changes: 422, commit_mismatch: 422, github_refused: 502,
} as const satisfies Record<CloudCodingGatewayRefusal, number>

function docs(summary: string, schema: z.ZodType, status: 200 | 201 = 200, setup = false) {
  return describeRoute({ tags: ["Internal"], summary, security: setup ? [] : [{ bearerAuth: [] }], responses: {
    [status]: jsonResponse(summary, schema), 401: jsonResponse("This task has ended or expired.", errorSchema),
    403: jsonResponse("Cloud coding is not available for this task.", errorSchema), 404: jsonResponse("The approval was not found.", errorSchema),
    409: jsonResponse("The branch or approval is not available.", errorSchema), 422: jsonResponse("This change could not be accepted.", errorSchema),
    502: jsonResponse("GitHub could not complete the request.", errorSchema),
  } })
}

function refusal(error: unknown) {
  if (error instanceof CloudCodingGithubError) return githubRefused()
  if (error instanceof CloudCodingChangeRefusal) return error
  throw error
}

const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
}

function answerRefusal(c: Context, error: unknown) {
  const { code, message } = refusal(error)
  return c.json({ error: code, message }, statuses[code])
}

const setupFailure = () => new CloudCodingChangeRefusal("task_closed", "This setup code was already used or has expired. Ask OpenWork to start the task again.")

async function readJson(c: Context, maxBytes: number): Promise<unknown> {
  const limit = () => new CloudCodingChangeRefusal("change_too_large", "This request is too large. Split the change into smaller changes.")
  if (Number(c.req.header("content-length")) > maxBytes) throw limit()
  const reader = c.req.raw.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      void reader.cancel().catch(() => undefined)
      throw limit()
    }
    chunks.push(value)
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) } catch { return null }
}

async function readBody<T>(c: Context, schema: z.ZodType<T>, maxBytes = Math.ceil(CLOUD_CODING_MAX_TOTAL_BYTES * 4 / 3) + 2_000_000) {
  const raw = await readJson(c, maxBytes)
  const body = schema.safeParse(raw)
  if (body.success) return body.data
  for (const issue of body.error.issues) {
    if (issue.path[0] !== "changeSet") continue
    switch (issue.path[1]) {
      case "branch": throw new CloudCodingChangeRefusal("invalid_branch", "Choose a valid name for a new branch.")
      case "baseSha": throw new CloudCodingChangeRefusal("base_not_found", "Provide the commit this work started from.")
      case "files":
        if (issue.code === "too_big" && issue.path.length === 2) throw new CloudCodingChangeRefusal("change_too_large", "There are too many files to push at once. Split this into smaller changes.")
        if (issue.code === "too_small" && issue.path.length === 2) throw new CloudCodingChangeRefusal("no_changes", "There are no files to push.")
        if (issue.code === "invalid_union" && issue.errors.some(errors => errors.some(error => error.path[0] === "path"))) throw new CloudCodingChangeRefusal("path_refused", "Provide a valid path for every file.")
        throw new CloudCodingChangeRefusal("file_mode_refused", "Send ordinary files or mark files as deleted. Symbolic links and submodules cannot be pushed.")
    }
  }
  throw new CloudCodingChangeRefusal("path_refused", "This request does not describe a valid change.")
}

type Prepared = Awaited<ReturnType<typeof prepareGatewayTask>>

async function withTask(c: Context, run: (gateway: Prepared) => Promise<Response>, options: { setupTask?: CloudCodingTaskRow; push?: boolean; finishedTask?: boolean } = {}) {
  let task: CloudCodingTaskRow | undefined
  let gateway: Prepared | undefined
  let approval: Awaited<ReturnType<typeof requireGatewayApproval>> | undefined
  try {
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1] ?? ""
    task = options.setupTask ?? await findGatewayTask(token, options.finishedTask)
    const member = await requireGatewayMember(task)
    const audited = await attributeAuditRequest(c, { organizationId: task.organizationId,
      actor: { type: "user", id: member.userId, memberId: task.orgMembershipId },
      principalKey: auditUserPrincipalKey({ userId: member.userId, memberId: task.orgMembershipId }), origin: "cloud_ui" })
    if (!audited.ok) return audited.response
    addAuditRequestResource(c, { type: "cloud_coding_task", id: task.id })
    gateway = await prepareGatewayTask(task, member)
    if (options.push) approval = await requireGatewayApproval(gateway, c.req.param("approvalId") ?? "")
    return await run(gateway)
  } catch (error) {
    const refused = refusal(error)
    if (options.push && task) {
      const capture = auditChangeCapture(c)
      const evidence = approval ?? { repositoryFullName: gateway?.repository.fullName ?? task.repositoryFullName }
      if (capture) await db.transaction(tx => recordGatewayEvent(tx, capture, "cloud_coding.push.refused", evidence, refused.code))
    }
    return answerRefusal(c, refused)
  }
}

export function registerCloudCodingGatewayRoutes<T extends { Variables: object }>(app: Hono<T>) {
  app.post(`${root}/setup`, docs("Redeem a Cloud coding setup code", cloudCodingGatewaySetupSchema, 200, true), tokenRoute, noStore, async c => {
    const raw = await readJson(c, 2048).catch(() => null)
    const input = cloudCodingGatewaySetupInputSchema.safeParse(raw)
    if (!input.success) return answerRefusal(c, setupFailure())
    const redeemed = await redeemCloudCodingSetupCode(input.data)
    if (!redeemed) return answerRefusal(c, setupFailure())
    return withTask(c, async gateway => c.json(cloudCodingGatewaySetupSchema.parse({ ...gatewayTaskView(gateway), token: redeemed.token,
      tokenExpiresAt: redeemed.tokenExpiresAt.toISOString() })), { setupTask: redeemed.task })
  })
  app.get(`${root}/task`, docs("Read the Cloud coding task", cloudCodingGatewayTaskSchema), tokenRoute, noStore,
    c => withTask(c, async gateway => c.json(cloudCodingGatewayTaskSchema.parse(gatewayTaskView(gateway))), { finishedTask: true }))
  app.post(`${root}/read-token`, docs("Issue a repository read token", cloudCodingReadTokenSchema), tokenRoute, noStore,
    c => withTask(c, async gateway => c.json(cloudCodingReadTokenSchema.parse(await issueGatewayReadToken(gateway)))))
  app.post(`${root}/push-approvals`, docs("Ask for a push approval", approvalEnvelope, 201), tokenRoute, noStore,
    c => withTask(c, async gateway => c.json(approvalEnvelope.parse(await requestGatewayPush(gateway, await readBody(c, cloudCodingPushRequestSchema), auditChangeCapture(c))), 201)))
  app.get(`${root}/push-approvals/:approvalId`, docs("Wait for a push decision", approvalEnvelope), tokenRoute, noStore,
    c => withTask(c, async gateway => {
      const waitMs = Number(c.req.query("waitMs") ?? 0)
      return c.json(approvalEnvelope.parse(await pollGatewayPush(gateway, c.req.param("approvalId"), Number.isNaN(waitMs) ? 0 : waitMs, c.req.raw.signal)))
    }, { finishedTask: true }))
  app.post(`${root}/push-approvals/:approvalId/push`, docs("Push the approved commit to a new branch", cloudCodingPushResultSchema), tokenRoute, noStore,
    c => withTask(c, async gateway => {
      const approval = await requireGatewayApproval(gateway, c.req.param("approvalId"))
      const { changeSet } = await readBody(c, cloudCodingPushInputSchema)
      return c.json(cloudCodingPushResultSchema.parse(await pushGatewayCommit(gateway, approval, changeSet, auditChangeCapture(c))))
    }, { push: true }))
  app.post(`${root}/pull-requests`, docs("Open the pull request for an approved push", cloudCodingOpenedPullRequestSchema), tokenRoute, noStore,
    c => withTask(c, async gateway => {
      const { approvalId } = await readBody(c, cloudCodingOpenPullRequestInputSchema, 2048)
      return c.json(cloudCodingOpenedPullRequestSchema.parse(await openGatewayPullRequest(gateway, approvalId, auditChangeCapture(c))))
    }, { finishedTask: true }))
}
