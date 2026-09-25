import { AuditLogError, appendAuditEvent, setAuditCaptureState, type AuditContext, type AuditEventInput } from "@openwork-ee/den-db/audit-log"
import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { auditCaptureUpdateSchema, auditEventsResponseSchema, auditEventTypesResponseSchema, auditOperationOutcomeSchema, auditOperationsResponseSchema, auditOriginSchema, auditUsageResponseSchema } from "@openwork/types/den/audit"
import type { Context, Hono } from "hono"
import type { RequestIdVariables } from "hono/request-id"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { readAuditEntitlement, readEffectiveAuditPolicy, recheckAuditEntitlement } from "../../audit/capture.js"
import { supportedAuditEventTypes } from "../../audit/coverage.js"
import { AuditReadError } from "../../audit/cursors.js"
import { auditCsv, auditNdjson } from "../../audit/exports.js"
import { auditExportQuerySchema, auditOperationsQuerySchema, auditPageQuerySchema, listAuditEvents, listAuditExportEvents, listAuditOperations, readAuditUsage } from "../../audit/queries.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { effectiveOrganizationRole, listOrganizationAdminTeamGrants } from "../../organization-team-roles.js"
import { denTypeIdSchema, enterprisePlanRequiredSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { ensureOrganizationAdmin, ensureOrganizationAdminRole, memberHasRole, orgAccessFailureStatus, type OrgRouteVariables } from "./shared.js"

type Variables = OrgRouteVariables & RequestIdVariables
type AuditRouteDescription = DescribeRouteOptions & { "x-mcp": false }
type AuditRouteContext = Pick<Context, "req" | "header" | "json"> & {
  get: <K extends "organizationContext" | "apiKey" | "requestId">(key: K) => Variables[K]
}
const describeAuditRoute = (options: AuditRouteDescription) => describeRoute({ security: [{ bearerAuth: [] }, { denApiKey: [] }], ...options })
const coverage = "Organization administrator access to currently captured, retained audit history only; this is not coverage of every cloud action. Legacy arbitrary payloads are preserved separately and are not backfilled or returned. One operation may contain multiple child events. Visibility is independent of capture entitlement. No duration, charge or continuous-drain guarantee is made."
const pagination = "Default limit 50, maximum 100. Cursors are signed, organization/filter/mode scoped and expire 24 hours after the first page (not renewed). Repeat the same filters; limit may change. The snapshotSequence is the committed tenant publication watermark, not a timestamp or auto-increment allocation. Events above it are excluded, including later children of an existing operation. Missing retained anchors or changed removal counters return 410 audit_history_unavailable; start a new snapshot. These checks are not lossless-drain or retention protection guarantees."
const filterDescription = "Time filters are inclusive operation-start bounds (ISO date or offset date-time; date-only means UTC midnight). actorId is the initiating user ID; outcome is the current OPERATION outcome, not an event outcome. action matches an exact stable action of any child event within the watermark. searchId is an exact case-sensitive ID match (1..255 characters, no controls), not free-text search: operation ID OR any canonical retained child event ID, child envelope requestId or child resource reference ID, scoped to this organization and operation within the watermark. Legacy payloads are not searched. All other filters are AND combined with searchId. Resource filters match stored references within the watermark, without live-resource joins; resourceType requires resourceId. Operation outcome/count/byte projections remain current rather than historical as-of-watermark values."
const errors = {
  400: jsonResponse("Malformed query, cursor, mismatched filters, operation scope or export format.", z.object({ error: z.enum(["audit_invalid_query", "audit_invalid_cursor"]) })),
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("Organization administrator permission and audit visibility required.", z.object({ error: z.enum(["forbidden", "audit_visibility_disabled"]), message: z.string().optional() })),
  404: jsonResponse("Organization or retained operation not found, including foreign-tenant targets.", z.object({ error: z.enum(["organization_not_found", "audit_operation_not_found"]) })),
  410: jsonResponse("Cursor expired or retained snapshot anchors/history are no longer available.", z.object({ error: z.enum(["audit_cursor_expired", "audit_history_unavailable"]) })),
  503: jsonResponse("Audit storage or required access capture unavailable; no audit content is released.", z.object({ error: z.enum(["audit_unavailable", "audit_storage_inconsistent"]) })),
}
const filterParameters: NonNullable<DescribeRouteOptions["parameters"]> = [
  ...["from", "to"].map((name) => ({ in: "query", name, schema: { anyOf: [{ type: "string", format: "date" }, { type: "string", format: "date-time", maxLength: 40 }] }, description: "Inclusive operation-start bound; date-only is UTC midnight. from must not exceed to." } satisfies NonNullable<DescribeRouteOptions["parameters"]>[number])),
  { in: "query", name: "actorId", schema: { type: "string", pattern: "^usr_[0-7][0-9a-hjkmnp-tv-z]{25}$" }, description: "Initiating user ID, not a delegated event actor or membership ID." },
  { in: "query", name: "action", schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_.-]*$" }, description: "Exact stable action of any child event within the snapshot watermark." },
  { in: "query", name: "outcome", schema: { type: "string", enum: auditOperationOutcomeSchema.options }, description: "Current operation outcome; not an individual event outcome." },
  { in: "query", name: "origin", schema: { type: "string", enum: auditOriginSchema.options }, description: "Stored operation origin." },
  { in: "query", name: "searchId", schema: { type: "string", minLength: 1, maxLength: 255, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" }, description: "Exact case-sensitive operation, child event, child request or stored child resource reference ID within the snapshot watermark; OR across ID kinds, AND with other filters. Not free-text or legacy payload search." },
  { in: "query", name: "resourceId", schema: { type: "string", minLength: 1, maxLength: 255 }, description: "Exact case-sensitive stored reference ID from any child within the watermark." },
  { in: "query", name: "resourceType", schema: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]*$" }, description: "Optional stored reference type; requires resourceId." },
]
const pageParameters: NonNullable<DescribeRouteOptions["parameters"]> = [
  { in: "query", name: "limit", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 }, description: "Maximum rows in this page." },
  { in: "query", name: "cursor", schema: { type: "string", maxLength: 4096 }, description: "Opaque nextCursor from the prior page of the same query and mode." },
]
function queryInput(c: AuditRouteContext) {
  const entries = Object.entries(c.req.queries())
  if (entries.some(([, values]) => values.length !== 1)) throw new AuditReadError("audit_invalid_query")
  return Object.fromEntries(entries.map(([name, values]) => [name, values[0]]))
}
function parseQuery<T>(schema: z.ZodType<T>, c: AuditRouteContext): T {
  const parsed = schema.safeParse(queryInput(c))
  if (!parsed.success) throw new AuditReadError("audit_invalid_query")
  return parsed.data
}

async function serveAudit(c: AuditRouteContext, action: "event_types" | "operations" | "events" | "usage" | "export", read: (organizationId: string) => Promise<Response>, operationId?: string) {
  c.header("Cache-Control", "no-store")
  const permission = ensureOrganizationAdminRole(c, "Only organization owners and admins can read audit history.")
  if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
  if (!("auditVisibilityEnabled" in env && env.auditVisibilityEnabled === true)) return c.json({ error: "audit_visibility_disabled" }, 403)
  const organization = c.get("organizationContext")
  if (!organization) return c.json({ error: "organization_not_found" }, 404)
  try {
    if (operationId !== undefined && !denTypeIdSchema("auditOperation").safeParse(operationId).success) throw new AuditReadError("audit_invalid_query")
    const credentialId = c.get("apiKey")?.id
    const context: AuditContext = {
      organizationId: organization.organization.id,
      actor: { type: "user", id: organization.currentMember.userId, memberId: organization.currentMember.id, ...(credentialId ? { credentialId } : {}) },
      principalKey: `user:${organization.currentMember.userId}:member:${organization.currentMember.id}:key:${credentialId ?? "session"}`,
      kind: "audit.access", scope: operationId ?? `audit.${action}`, origin: "api", originTrust: "authenticated", requestId: c.get("requestId") ?? createDenTypeId("request"),
    }
    const capture = await db.transaction(async (tx) => {
      const policy = await readEffectiveAuditPolicy(tx, context.organizationId, env.auditCaptureEnabled, true)
      const category = policy?.categories.includes("access") ? "access" : policy?.categories.includes("read") ? "read" : null
      if (!policy || !category) return null
      const event: AuditEventInput = { action: `audit.${action}.requested`, category, outcome: "unknown", resources: [{ type: operationId ? "audit_operation" : "audit_collection", id: operationId ?? `audit.${action}`, relationship: "target" }] }
      const intent = await appendAuditEvent(tx, { context, policy, event })
      if (!intent) throw new Error("audit_access_not_recorded")
      return { policy, event, intent }
    })
    const response = await read(organization.organization.id)
    if (capture) await db.transaction(async (tx) => {
      await recheckAuditEntitlement(tx, context.organizationId)
      const served = await appendAuditEvent(tx, { context, policy: capture.policy, event: { ...capture.event, action: `audit.${action}.served`, outcome: "succeeded" } })
      if (served?.operationId !== capture.intent.operationId) throw new Error("audit_access_operation_changed")
    })
    return response
  } catch (error) {
    return error instanceof AuditReadError ? c.json({ error: error.code }, error.status) : c.json({ error: "audit_unavailable" }, 503)
  }
}

export function registerOrgAuditRoutes<T extends { Variables: Variables }>(app: Hono<T>) {
  app.patch("/v1/audit/settings", describeAuditRoute({
    operationId: "updateAuditCapture", tags: ["Organizations"], "x-mcp": false, summary: "Set organization audit capture",
    description: "Fresh organization administrator authorization and visibility required. Only captureOn and expectedRevision are accepted. Enabling requires Enterprise or explicit installation entitlement, capture rollout availability and an operator-initialized policy. Disabling remains available after entitlement loss. Revision conflicts require refresh; matching no-ops do not record duplicate events. Changes and immutable lifecycle evidence commit atomically. Retained history and capacity configuration are unchanged.",
    responses: { ...errors,
      200: jsonResponse("Latest audit policy, entitlement and retained usage.", auditUsageResponseSchema),
      400: jsonResponse("Only captureOn and a nonnegative safe expectedRevision are accepted.", invalidRequestSchema),
      402: jsonResponse("Enabling capture requires audit availability.", enterprisePlanRequiredSchema),
      403: jsonResponse("Administrator permission, fresh authentication and visibility required.", z.union([forbiddenSchema, z.object({ error: z.literal("audit_visibility_disabled") })])),
      409: jsonResponse("Refresh a changed policy, request operator initialization or wait for capture rollout.", z.object({ error: z.enum(["audit_policy_changed", "audit_policy_not_configured", "audit_capture_unavailable"]) })),
    },
  } satisfies AuditRouteDescription), orgMemberRoute(), jsonValidator(auditCaptureUpdateSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const permission = ensureOrganizationAdmin(c, "Only organization owners and admins can change audit capture.")
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    if (!env.auditVisibilityEnabled) return c.json({ error: "audit_visibility_disabled" }, 403)
    const organization = c.get("organizationContext")
    const input = c.req.valid("json")
    try {
      const rejection = await db.transaction(async (tx) => {
        const entitlement = await readAuditEntitlement(tx, organization.organization.id, true)
        const [member] = await tx.select().from(MemberTable).where(and(eq(MemberTable.id, organization.currentMember.id), eq(MemberTable.organizationId, organization.organization.id), eq(MemberTable.userId, organization.currentMember.userId), isNull(MemberTable.removedAt))).limit(1).for("share")
        if (!member) return "forbidden"
        const adminTeams = memberHasRole(member.role, "admin") ? [] : (await listOrganizationAdminTeamGrants(organization.organization.id, tx)).filter((grant) => grant.memberId === member.id)
        if (!memberHasRole(effectiveOrganizationRole(member.role, adminTeams), "admin")) return "forbidden"
        if (input.captureOn && !entitlement.enabled) return "enterprise_plan_required"
        if (input.captureOn && !env.auditCaptureEnabled) return "audit_capture_unavailable"
        const credentialId = c.get("apiKey")?.id
        await setAuditCaptureState(tx, { ...input, context: {
          organizationId: organization.organization.id, actor: { type: "user", id: member.userId, memberId: member.id, ...(credentialId ? { credentialId } : {}) },
          principalKey: `user:${member.userId}:member:${member.id}:key:${credentialId ?? "session"}`,
          kind: "audit.policy", scope: organization.organization.id, origin: "api", originTrust: "authenticated", requestId: c.get("requestId") ?? createDenTypeId("request"),
        } })
        return null
      })
      if (rejection === "forbidden") return c.json({ error: rejection }, 403)
      if (rejection === "enterprise_plan_required") return c.json({ error: rejection, feature: "auditLogs", message: "Audit logs requires an Enterprise plan or explicit self-hosted installation entitlement." }, 402)
      if (rejection === "audit_capture_unavailable") return c.json({ error: rejection }, 409)
      return c.json(await readAuditUsage({ database: db, organizationId: organization.organization.id }, env.auditCaptureEnabled))
    } catch (error) {
      if (error instanceof AuditLogError && (error.code === "audit_policy_changed" || error.code === "audit_policy_not_configured")) return c.json({ error: error.code }, 409)
      return c.json({ error: "audit_unavailable" }, 503)
    }
  })

  app.get("/v1/audit/event-types", describeAuditRoute({
    operationId: "getAuditEventTypes", tags: ["Organizations"], "x-mcp": false, summary: "List supported audit event types",
    description: "Organization administrator and audit visibility required. Returns the static supported semantic action catalog from the executable provider, audit-read, capture-settings and pilot-policy coverage registries, including hidden child actions and this endpoint's access events. Unique deterministic lexicographic order. This fixed bounded catalog needs no pagination or observed full-history DISTINCT scan. It is independent of loaded rows, time/filter selection and capture category enablement, including empty history; support does not imply this organization has events of every type or that every cloud action is captured. Legacy event types are excluded. Access capture uses the same content-free requested/served policy as other audit reads.",
    responses: { ...errors, 200: jsonResponse("The full static supported action catalog, not observed tenant event counts.", auditEventTypesResponseSchema) },
  } satisfies AuditRouteDescription), orgMemberRoute(), (c) => serveAudit(c, "event_types", async () => {
    parseQuery(z.object({}).strict(), c)
    return c.json(auditEventTypesResponseSchema.parse({ eventTypes: supportedAuditEventTypes() }))
  }))

  app.get("/v1/audit/operations", describeAuditRoute({
    operationId: "getAuditOperations", tags: ["Organizations"], "x-mcp": false, summary: "List retained audit operations",
    description: `${coverage} ${pagination} ${filterDescription} Newest operations first, ordered by server first-recorded time then ID. Summary action and resources describe the FIRST event only (at most 256 stored references), not all affected resources. Expand events for complete evidence; X-Audit-Resource-Scope is first_event.`,
    parameters: [...pageParameters, ...filterParameters],
    responses: { ...errors, 200: { ...jsonResponse("One bounded summary per operation.", auditOperationsResponseSchema), headers: { "X-Audit-Resource-Scope": { schema: { type: "string", enum: ["first_event"] }, description: "Summary references are from the first event only, not an exhaustive operation inventory." } } } },
  } satisfies AuditRouteDescription), orgMemberRoute(), (c) => serveAudit(c, "operations", async (organizationId) => {
    const query = parseQuery(auditOperationsQuerySchema, c)
    const result = await listAuditOperations({ database: db, organizationId, secret: env.betterAuthSecret }, query)
    c.header("X-Audit-Resource-Scope", "first_event")
    return c.json(result)
  }))

  app.get("/v1/audit/operations/:operationId/events", describeAuditRoute({
    operationId: "getAuditOperationEvents", tags: ["Organizations"], "x-mcp": false, summary: "List retained operation events",
    description: `${coverage} ${pagination} Events are in ascending tenant sequence order and carry complete versioned envelopes. Missing or foreign retained operations return the same 404.`,
    parameters: [...pageParameters, { in: "path", name: "operationId", required: true, schema: { type: "string", pattern: "^aop_[0-7][0-9a-hjkmnp-tv-z]{25}$" } }],
    responses: { ...errors, 200: jsonResponse("A bounded ascending page of event envelopes.", auditEventsResponseSchema) },
  } satisfies AuditRouteDescription), orgMemberRoute(), (c) => {
    const operationId = c.req.param("operationId")
    return serveAudit(c, "events", async (organizationId) => c.json(await listAuditEvents({ database: db, organizationId, secret: env.betterAuthSecret }, parseQuery(auditPageQuerySchema, c), operationId)), operationId)
  })

  app.get("/v1/audit/usage", describeAuditRoute({
    operationId: "getAuditUsage", tags: ["Organizations"], "x-mcp": false, summary: "Read audit retention usage",
    description: `${coverage} Reads stored policy and tenant counters, plus the oldest retained operation. Capture requires audit entitlement, organization captureOn and the deployment capture flag. Entitlement and rollout availability alone never initialize a policy or start capture. Billing is disabled, cleanup is dry-run only and drains are not configured. Logical bytes are not physical database size; access capture may itself add one operation.`,
    responses: { ...errors, 200: jsonResponse("Current stored audit policy and usage, without a history scan.", auditUsageResponseSchema) },
  } satisfies AuditRouteDescription), orgMemberRoute(), (c) => serveAudit(c, "usage", async (organizationId) => {
    parseQuery(z.object({}).strict(), c)
    return c.json(await readAuditUsage({ database: db, organizationId }, "auditCaptureEnabled" in env && env.auditCaptureEnabled === true))
  }))

  app.get("/v1/audit/export", describeAuditRoute({
    operationId: "getAuditExport", tags: ["Organizations"], "x-mcp": false, summary: "Export one audit snapshot page",
    description: `${coverage} ${pagination} ${filterDescription} Exports ALL matching operations' children within the watermark in ascending tenant sequence, not date/ID order. Each response is one bounded attachment, not a continuous drain. Follow X-Audit-Next-Cursor with the same format and filters until that header is absent. X-Audit-Snapshot-Sequence stays fixed. NDJSON has one full envelope per line. CSV has a header on every page and summary fields only: references and changed-field names are JSON cells, no before/after content. Every cell is quoted; formula-leading whitespace/control and =+-@ are prefixed with an apostrophe, backslashes are doubled, controls/multiline characters are encoded as literal backslash-u escapes.`,
    parameters: [...pageParameters, ...filterParameters, { in: "query", name: "format", schema: { type: "string", enum: ["ndjson", "csv"], default: "ndjson" } }],
    responses: { ...errors, 200: { description: "A bounded attachment page. No next-cursor header means this snapshot is exhausted.", content: { "application/x-ndjson": { schema: { type: "string" } }, "text/csv": { schema: { type: "string" } } }, headers: {
      "X-Audit-Next-Cursor": { description: "Opaque continuation; absent on the last page.", schema: { type: "string" } },
      "X-Audit-Snapshot-Sequence": { description: "Frozen committed tenant publication watermark.", schema: { type: "string", pattern: "^[0-9]+$" } },
      "Content-Disposition": { description: "Attachment filename for this page.", schema: { type: "string" } },
    } } },
  } satisfies AuditRouteDescription), orgMemberRoute(), (c) => serveAudit(c, "export", async (organizationId) => {
    const query = parseQuery(auditExportQuerySchema, c)
    const result = await listAuditExportEvents({ database: db, organizationId, secret: env.betterAuthSecret }, query)
    const content = query.format === "csv" ? auditCsv(result.events) : auditNdjson(result.events)
    const headers = new Headers({ "Content-Type": query.format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="audit-${result.snapshotSequence}.${query.format}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Audit-Snapshot-Sequence": String(result.snapshotSequence) })
    if (result.nextCursor) headers.set("X-Audit-Next-Cursor", result.nextCursor)
    return new Response(content, { headers })
  }))
}
