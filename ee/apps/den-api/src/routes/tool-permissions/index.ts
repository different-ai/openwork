import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { decideToolApprovalSchema, setToolPermissionRuleSchema, setToolPermissionWrittenRulesSchema, toolApprovalListSchema, toolApprovalSchema, toolPermissionsQuerySchema, toolPermissionsSchema } from "@openwork/types/den/tool-permissions"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { getExternalMcpConnection } from "../../capability-sources/external-mcp-connections.js"
import { db } from "../../db.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator, queryValidator, type OrganizationContextVariables, verifyOrgRole } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { decideToolApproval, listPendingMemberToolApprovals, toolApprovalView } from "../../tool-permissions/approvals.js"
import { listOrganizationToolRules, readOrganizationWrittenToolRules, setSubjectToolRule, writeOrganizationWrittenToolRules } from "../../tool-permissions/rules.js"

type Variables = Partial<OrganizationContextVariables> & Partial<AuthContextVariables>
const approvalIdSchema = z.object({ approvalId: z.string().min(1).max(160) })
const conflictSchema = z.object({ error: z.enum(["tool_approval_decided", "tool_permission_rules_limit"]), message: z.string() })

const denyMcpDispatch: MiddlewareHandler<{ Variables: Variables }> = async (c, next) => {
  if (c.get("session")?.id === "mcp_internal") return c.json({ error: "forbidden" }, 403)
  await next()
}

function metadata(operationId: string, summary: string, schema: typeof toolPermissionsSchema | typeof toolApprovalListSchema | typeof toolApprovalSchema, options: { validates?: boolean; conflict?: string } = {}) {
  return describeRoute({
    operationId, summary, tags: ["Tool permissions"], security: [{ bearerAuth: [] }, { denApiKey: [] }],
    responses: {
      200: jsonResponse("Success.", schema),
      ...(options.validates ? { 400: jsonResponse("Invalid request.", invalidRequestSchema) } : {}),
      401: jsonResponse("Sign in first.", unauthorizedSchema),
      403: jsonResponse("This caller cannot use this operation.", forbiddenSchema),
      404: jsonResponse("Tool permissions are off or the requested resource does not belong to this organization or caller.", notFoundSchema),
      ...(options.conflict ? { 409: jsonResponse(options.conflict, conflictSchema) } : {}),
    },
  })
}

async function connectionForOrganization(organizationId: string, connectionId: string) {
  if (!isDenTypeId("externalMcpConnection", connectionId)) return null
  const connection = await getExternalMcpConnection({ organizationId: normalizeDenTypeId("organization", organizationId), connectionId: normalizeDenTypeId("externalMcpConnection", connectionId) }, db.$primary)
  return connection?.kind === "external_mcp" ? connection : null
}

async function permissions(organizationId: string, connectionId?: string) {
  const [rules, writtenRules] = await Promise.all([listOrganizationToolRules(organizationId, connectionId), readOrganizationWrittenToolRules(organizationId, { fresh: true })])
  return { rules, writtenRules }
}

export function registerToolPermissionRoutes<T extends { Variables: Variables }>(app: Hono<T>) {
  const gate = requireFeature("toolPermissions")
  const admin: MiddlewareHandler<{ Variables: OrganizationContextVariables }> = async (c, next) => {
    if (!verifyOrgRole({ roles: ["admin"], userContext: c.get("organizationContext").currentMember })) {
      return c.json({ error: "forbidden", message: "Only workspace owners and admins can do this." }, 403)
    }
    await next()
  }

  app.get("/v1/org/tool-permissions",
    metadata("getOrganizationToolPermissions", "Read the organization's tool rules", toolPermissionsSchema, { validates: true }),
    orgMemberRoute(), gate, denyMcpDispatch, admin, queryValidator(toolPermissionsQuerySchema), async (c) => {
      const { organization } = c.get("organizationContext")
      const { connectionId } = c.req.valid("query")
      if (connectionId === undefined) return c.json(await permissions(organization.id))
      const connection = await connectionForOrganization(organization.id, connectionId)
      if (!connection) return c.json({ error: "connection_not_found" }, 404)
      return c.json(await permissions(organization.id, connection.id))
    })

  app.put("/v1/org/tool-permissions/rule",
    metadata("setOrganizationToolPermissionRule", "Set or remove one tool rule", toolPermissionsSchema, { validates: true, conflict: "The organization has reached its tool rule limit." }),
    orgMemberRoute(), gate, denyMcpDispatch, admin, jsonValidator(setToolPermissionRuleSchema), async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      const { subject, connectionId, toolName, rule } = c.req.valid("json")
      const connection = await connectionForOrganization(organization.id, connectionId)
      if (!connection) return c.json({ error: "connection_not_found" }, 404)
      const { kind } = subject
      const id = kind === "organization" ? organization.id : isDenTypeId(kind, subject.id) ? normalizeDenTypeId(kind, subject.id) : null
      if (id === null) return c.json({ error: "tool_permission_subject_not_found" }, 404)
      try {
        await setSubjectToolRule({ organizationId: organization.id, kind, id }, { connectionId: connection.id, toolName, rule }, currentMember.id)
      } catch (error) {
        if (error instanceof Error && error.message === "tool_permission_subject_not_found") return c.json({ error: error.message }, 404)
        if (error instanceof Error && error.message === "tool_permission_rules_limit") {
          return c.json({ error: error.message, message: "This organization has reached its tool rule limit. Remove a rule before adding another." }, 409)
        }
        throw error
      }
      addAuditRequestResource(c, { type: "organization", id: organization.id })
      addAuditRequestResource(c, { type: "mcp_connection", id: connection.id })
      return c.json(await permissions(organization.id, connection.id))
    })

  app.put("/v1/org/tool-permissions/written-rules",
    metadata("setOrganizationWrittenToolRules", "Set the organization's written tool rules", toolPermissionsSchema, { validates: true }),
    orgMemberRoute(), gate, denyMcpDispatch, admin, jsonValidator(setToolPermissionWrittenRulesSchema), async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      await writeOrganizationWrittenToolRules(organization.id, c.req.valid("json").rules, currentMember.id)
      addAuditRequestResource(c, { type: "organization", id: organization.id })
      return c.json(await permissions(organization.id))
    })

  app.get("/v1/tool-approvals",
    metadata("listToolApprovals", "List your pending chat and Automation tool approvals from the last 30 days", toolApprovalListSchema),
    orgMemberRoute(), gate, denyMcpDispatch, async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      return c.json({ items: await listPendingMemberToolApprovals(organization.id, currentMember.id) })
    })

  app.post("/v1/tool-approvals/:approvalId/decision",
    metadata("decideToolApproval", "Allow once or deny your pending tool approval", toolApprovalSchema, { validates: true, conflict: "Someone already decided this." }),
    orgMemberRoute(), gate, denyMcpDispatch, paramValidator(approvalIdSchema), jsonValidator(decideToolApprovalSchema), async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      const { approvalId } = c.req.valid("param")
      const { decision } = c.req.valid("json")
      try {
        const approval = await decideToolApproval({ organizationId: organization.id, memberId: currentMember.id, approvalId, decision })
        if (!approval) return c.json({ error: "tool_approval_not_found" }, 404)
        return c.json(toolApprovalView(approval))
      } catch (error) {
        if (error instanceof Error && error.message === "tool_approval_decided") {
          return c.json({ error: error.message, message: "Someone already decided this." }, 409)
        }
        throw error
      }
    })
}
