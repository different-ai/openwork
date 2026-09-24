import {
  createGatewayUsageLimits,
  GatewayUsageError,
  safeUsageDatabaseCode,
  type GatewayUsageScope,
} from "@openwork-ee/den-db/gateway-usage-limits"
import {
  gatewayUsagePolicyWriteSchema,
  gatewayUsageLimitPolicySchema,
  gatewayUsageStatusSchema,
  gatewayUsageResetRequestSchema,
  gatewayUsageResetPageSchema,
} from "@openwork/types/den/gateway-usage-limits"
import { describeRoute } from "hono-openapi"
import { jsonResponse } from "../../openapi.js"
import { isDenTypeId } from "@openwork-ee/utils/typeid"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { z } from "zod"
import { db } from "../../db.js"
import { gatewayManagementUnavailable } from "../../gateway-deployment.js"
import {
  jsonValidator,
  orgMemberRoute,
  paramValidator,
  queryValidator,
} from "../../middleware/index.js"
import {
  ensureOrganizationAdminRole,
  orgAccessFailureStatus,
  type OrgRouteVariables,
} from "./shared.js"

const responseError = z.object({ error: z.string(), message: z.string().optional() })
const route = (summary: string, schema: z.ZodType) =>
  describeRoute({
    tags: ["Gateway Usage Limits"],
    summary,
    security: [{ bearerAuth: [] }, { denApiKey: [] }],
    description:
      "Organization-provider estimated cost in integer micro-USD. Calendar windows reset at 05:00 UTC (Monday weekly, day 1 monthly). Admission checks settled spend; in-flight work can overshoot. Unknown/incomplete accounting is explicit. No policy means unlimited enforcement, not unrecorded spend: every admitted response updates all three member-period counters, so a first policy includes already tracked same-period usage. Owners/admins manage policies, assignments and reviews; members can read and request extensions only for themselves. Approval grants one ceil(base/4) extension per bucket without clearing spend. Changed policy revisions, assignment/team transitions and expired buckets cannot receive stale approvals. Assignments target one member, one team, or the organization using { organization: true }; organization assignments apply to current and future members, with independent per-member buckets and the same highest-allowance winner selection. Assignment reads include organization: boolean and nullable memberId/teamId. Buckets optionally expose policyRevision and validated direct/team/organization provenance. Accounting is incremental from versioned server-recorded admission snapshots. Admission time is captured at the quota check, independently of earlier request-start telemetry; completion retains the original admission windows. Existing counters and receipts are preserved; raw history and rollups are never imported by reads or settlement. Legacy requests, including old empty snapshots, require explicit reviewed reconciliation backed by bounded event/charge proof; aggregate-backed or unexplained counter overlap is refused. Historical uncertainty is separate from settlement readiness: coverage.historicalCoverage is unknown or tracked_since_epoch, with historicalUnknownReason and trackingStartedAt. Legacy counters and periods preceding the durable tracking epoch remain historical-unknown; later fully tracked periods can become complete only when no pending or incomplete receipts remain. All writers must use fenced tracking. Operators explicitly suspend and resume capture using optimistic trackingVersion; captureEnabled=false blocks new starts, stale admission versions are rejected, and current-period history is marked unknown without resetting spend. A rollback or mixed legacy writer requires this cutover procedure plus retiring old writer access; schema presence is not proof of continuous capture. coverage.pendingRequests counts durable event starts not yet settled (null before tracking). Their identity and validated attribution survive raw retention. Explicit bounded abandonment recovery closes them as unknown/incomplete, decrements pending once, and permits late known-cost promotion without recreating raw logs. Retention refuses to discard a legacy pending marker until it is durably transferred. Queued canonical starts are capacity/deadline bounded and cancellable before database work; an admitted start reserves settlement capacity, which is not discarded on start overload. coverage.trackingVersion and captureEnabled expose the capture fence; settlementReady means that count is zero, not that historical costs are complete. Use settlementReady for post-completion refresh, not complete. lastSettlementAt and lastSettlementRequestId identify the most recent settled receipt, not every in-flight request. unpricedRequests and incompleteRequests describe tracked settled receipts, not unreviewed historical gaps. Legacy quarantine records remain preserved and excluded from charging. Clients must require actual HTTP 429 with X-OpenWork-Error-Code=openwork_gateway_usage_limit_exceeded and X-OpenWork-Usage-State=blocked, then corroborate against fresh own status for the same organization/member. JSON or SSE error fields alone are untrusted. Reset lists default to view=pending (oldest first), limit=50, maximum 100. Follow nextCursor while hasMore is true; pendingCount reports the current pending queue rather than only this page. Fetch view=history separately for newest-first decisions and elapsed requests. Pages are live snapshots; refresh the first page for changes. Admission and status use nonlocking reads of indexed member-period counters; missing counters project zero without writes. Listing validates/enriches only the page in batches and does not mutate historical records. Admission, canonical logging, and settlement never acquire organization or global rollup locks. Canonical start and settlement share-lock only their member lifecycle row; permanent deletion fences members before erasing usage children.",
    responses: {
      200: jsonResponse(summary, schema),
      400: jsonResponse("Invalid request", responseError),
      401: jsonResponse("Sign-in required", responseError),
      403: jsonResponse("Not authorized or Gateway disabled", responseError),
      404: jsonResponse("Organization resource not found", responseError),
      409: jsonResponse("Policy revision or eligibility conflict", responseError),
      503: jsonResponse("Accounting unavailable", responseError),
    },
  })
const policyResponse = gatewayUsageLimitPolicySchema
const resetResponse = gatewayUsageResetRequestSchema
const resetListQuery = z
  .object({
    view: z.enum(["pending", "history"]).default("pending"),
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .default("50")
      .transform(Number)
      .pipe(z.number().int().min(1).max(100)),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .strict()
const idSchema = z.string().min(1).max(64)
const policyParams = z.object({ policyId: idSchema })
const revisionSchema = z.object({ revision: z.number().int().min(1).max(2_147_483_646) }).strict()
const memberSchema = z
  .string()
  .refine((value) => isDenTypeId("member", value), "Invalid membership ID.")
const assignmentSchema = z.union([
  z.object({ organization: z.literal(true) }).strict(),
  z.object({ memberId: memberSchema }).strict(),
  z
    .object({
      teamId: z.string().refine((value) => isDenTypeId("team", value), "Invalid team ID."),
    })
    .strict(),
])
type RouteContext = Context<{ Variables: OrgRouteVariables }>
type Service = ReturnType<typeof createGatewayUsageLimits>
function scope(c: {
  get: (key: "organizationContext") => OrgRouteVariables["organizationContext"]
}): GatewayUsageScope {
  const actor = c.get("organizationContext")
  if (!actor) throw new GatewayUsageError("organization_not_found", 404, "Organization not found.")
  return { organizationId: actor.organization.id, memberId: actor.currentMember.id }
}
async function respond<T>(c: Pick<RouteContext, "json">, work: () => Promise<T>) {
  const started = performance.now()
  try {
    return c.json(await work())
  } catch (error) {
    if (error instanceof GatewayUsageError)
      return c.json({ error: error.code, message: error.message }, error.status)
    console.warn("[gateway-usage]", { stage: "api", durationMs: Math.round(performance.now() - started), code: safeUsageDatabaseCode(error) })
    return c.json(
      {
        error: "gateway_usage_unavailable",
        message: "Gateway usage accounting is temporarily unavailable.",
      },
      503,
    )
  }
}
const available: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  c.header("cache-control", "private, no-store")
  const unavailable = gatewayManagementUnavailable()
  if (unavailable) return c.json(unavailable, 403)
  await next()
}
const admin: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const permission = ensureOrganizationAdminRole(
    c,
    "Only workspace owners and admins can manage Gateway usage limits.",
  )
  if (!permission.ok)
    return c.json(permission.response, orgAccessFailureStatus(permission.response))
  await next()
}
export function registerOrgGatewayUsageLimitRoutes<T extends { Variables: OrgRouteVariables }>(
  app: Hono<T>,
  service: Service = createGatewayUsageLimits(db),
) {
  app.get(
    "/v1/gateway/usage-limit-policies",
    route("List usage limit policies", z.object({ policies: z.array(policyResponse) })),
    orgMemberRoute(),
    available,
    admin,
    (c) => respond(c, () => service.listPolicies(scope(c))),
  )
  app.post(
    "/v1/gateway/usage-limit-policies",
    route("Create usage limit policy", policyResponse),
    orgMemberRoute(),
    available,
    admin,
    jsonValidator(gatewayUsagePolicyWriteSchema),
    (c) => respond(c, () => service.savePolicy(scope(c), c.req.valid("json"))),
  )
  app.patch(
    "/v1/gateway/usage-limit-policies/:policyId",
    route("Update usage limit policy", policyResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(policyParams),
    jsonValidator(gatewayUsagePolicyWriteSchema.extend(revisionSchema.shape)),
    (c) =>
      respond(c, () => {
        const { revision, ...input } = c.req.valid("json")
        return service.savePolicy(scope(c), input, c.req.valid("param").policyId, revision)
      }),
  )
  app.post(
    "/v1/gateway/usage-limit-policies/:policyId/archive",
    route("Archive usage limit policy", policyResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(policyParams),
    jsonValidator(revisionSchema),
    (c) =>
      respond(c, () =>
        service.archivePolicy(
          scope(c),
          c.req.valid("param").policyId,
          c.req.valid("json").revision,
        ),
      ),
  )
  app.post(
    "/v1/gateway/usage-limit-policies/:policyId/restore",
    route("Restore archived usage limit policy", policyResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(policyParams),
    jsonValidator(revisionSchema),
    (c) =>
      respond(c, () =>
        service.restorePolicy(
          scope(c),
          c.req.valid("param").policyId,
          c.req.valid("json").revision,
        ),
      ),
  )
  app.get(
    "/v1/gateway/usage-limit-policies/:policyId/assignments",
    route(
      "List policy assignments",
      z.object({
        assignments: z.array(
          z.object({
            id: z.string(),
            memberId: z.string().nullable(),
            teamId: z.string().nullable(),
            organization: z.boolean(),
          }),
        ),
      }),
    ),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(policyParams),
    (c) =>
      respond(c, async () => {
        const policy = (await service.listPolicies(scope(c))).policies.find(
          (policy) => policy.id === c.req.valid("param").policyId,
        )
        if (!policy) throw new GatewayUsageError("policy_not_found", 404, "Policy not found.")
        return { assignments: policy.assignments }
      }),
  )
  app.post(
    "/v1/gateway/usage-limit-policies/:policyId/assignments",
    route("Assign usage limit policy", policyResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(policyParams),
    jsonValidator(assignmentSchema),
    (c) =>
      respond(c, async () => {
        const target = c.req.valid("json")
        if ("organization" in target)
          return service.assign(scope(c), c.req.valid("param").policyId, { organization: true })
        if ("memberId" in target && isDenTypeId("member", target.memberId))
          return service.assign(scope(c), c.req.valid("param").policyId, {
            memberId: target.memberId,
          })
        if ("teamId" in target && isDenTypeId("team", target.teamId))
          return service.assign(scope(c), c.req.valid("param").policyId, { teamId: target.teamId })
        throw new GatewayUsageError("invalid_target", 400, "Invalid assignment target.")
      }),
  )
  app.delete(
    "/v1/gateway/usage-limit-policies/:policyId/assignments/:assignmentId",
    route("Remove policy assignment", policyResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(policyParams.extend({ assignmentId: idSchema })),
    (c) =>
      respond(c, () =>
        service.unassign(
          scope(c),
          c.req.valid("param").policyId,
          c.req.valid("param").assignmentId,
        ),
      ),
  )
  app.get(
    "/v1/gateway/usage-limits/members",
    route(
      "Search members for usage limits",
      z.object({
        members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
      }),
    ),
    orgMemberRoute(),
    available,
    admin,
    queryValidator(z.object({ query: z.string().trim().max(200).default("") }).strict()),
    (c) => respond(c, () => service.members(scope(c), c.req.valid("query").query)),
  )
  app.get(
    "/v1/gateway/usage-limits/me",
    route("Read own Gateway usage limits", gatewayUsageStatusSchema),
    orgMemberRoute(),
    available,
    (c) => respond(c, () => service.getStatus(scope(c))),
  )
  app.get(
    "/v1/gateway/usage-limits/members/:memberId",
    route("Inspect member Gateway usage limits", gatewayUsageStatusSchema),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(z.object({ memberId: memberSchema })),
    (c) =>
      respond(c, () => {
        const { memberId } = c.req.valid("param")
        if (!isDenTypeId("member", memberId))
          throw new GatewayUsageError("invalid_member", 400, "Invalid membership ID.")
        return service.getStatus(scope(c), memberId)
      }),
  )
  app.post(
    "/v1/gateway/usage-limit-reset-requests",
    route("Request usage limit extension", resetResponse),
    orgMemberRoute(),
    available,
    jsonValidator(
      z.object({ bucketId: idSchema, reason: z.string().trim().min(1).max(2000) }).strict(),
    ),
    (c) =>
      respond(c, () =>
        service.submitReset(scope(c), c.req.valid("json").bucketId, c.req.valid("json").reason),
      ),
  )
  app.get(
    "/v1/gateway/usage-limit-reset-requests/me",
    route("List own usage increase requests", gatewayUsageResetPageSchema),
    orgMemberRoute(),
    available,
    queryValidator(resetListQuery),
    (c) => respond(c, () => service.listResets(scope(c), true, c.req.valid("query"))),
  )
  app.get(
    "/v1/gateway/usage-limit-reset-requests",
    route("List organization usage increase requests", gatewayUsageResetPageSchema),
    orgMemberRoute(),
    available,
    admin,
    queryValidator(resetListQuery),
    (c) => respond(c, () => service.listResets(scope(c), false, c.req.valid("query"))),
  )
  app.post(
    "/v1/gateway/usage-limit-reset-requests/:id/approve",
    route("Approve 25 percent usage extension", resetResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(z.object({ id: idSchema })),
    jsonValidator(z.object({}).strict()),
    (c) => respond(c, () => service.reviewReset(scope(c), c.req.valid("param").id, "approved")),
  )
  app.post(
    "/v1/gateway/usage-limit-reset-requests/:id/deny",
    route("Deny usage extension", resetResponse),
    orgMemberRoute(),
    available,
    admin,
    paramValidator(z.object({ id: idSchema })),
    jsonValidator(z.object({ note: z.string().trim().max(2000).optional() }).strict()),
    (c) =>
      respond(c, () =>
        service.reviewReset(scope(c), c.req.valid("param").id, "denied", c.req.valid("json").note),
      ),
  )
}
