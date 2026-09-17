import { and, desc, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { GatewayProviderTable, GatewayRouterTable, MemberTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { gatewayRouterDefinitionSchema, gatewayRouterSummarySchema, gatewayRouterTargetSchema, gatewayRouterUpdateSchema, isGatewayRouterTargetNpm, type GatewayRouterDefinition, type GatewayRouterSummary, type GatewayRouterTarget } from "@openwork/types/den/gateway-router"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { gatewayManagementUnavailable, gatewayManagementUnavailableSchema } from "../../gateway-deployment.js"
import { GatewayWriteError, gatewaySummary, type GatewayTx } from "../../llm/gateway-matrix.js"
import { readProviderConfigNpm } from "../../llm/inference-provider-config.js"
import { jsonValidator, orgMemberRoute, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

type Actor = NonNullable<OrgRouteVariables["organizationContext"]>
type Router = typeof GatewayRouterTable.$inferSelect
const params = z.object({ routerId: denTypeIdSchema("gatewayRouter") })
const response = z.object({ router: gatewayRouterSummarySchema })
const errorSchema = z.object({ error: z.string(), message: z.string().optional() })
function metadata(summary: string, schema?: z.ZodType, status: 200 | 201 | 204 = 200) {
  return describeRoute({ tags: ["Gateway Routers"], summary,
    description: "Private member-owned Gateway routers. Requires live organization membership and enabled Gateway deployment. Active creates and updates require every target to be a currently usable OpenAI-compatible gateway model alias. Disabled routers may be created or updated without target availability checks; schema validation, ownership, membership and revision checks still apply. Upstream credentials are never returned.",
    responses: {
      [status]: schema ? jsonResponse(summary, schema) : emptyResponse(summary),
      400: jsonResponse("Invalid router or unsupported target.", z.union([invalidRequestSchema, errorSchema])),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
      403: jsonResponse("Membership, target access or deployment denied.", z.union([forbiddenSchema, gatewayManagementUnavailableSchema, errorSchema])),
      404: jsonResponse("Router not found.", notFoundSchema),
      409: jsonResponse("Stale router revision.", errorSchema),
    },
  })
}
function owned(actor: Actor) {
  return and(eq(GatewayRouterTable.organization_id, actor.organization.id), eq(GatewayRouterTable.created_by_org_membership_id, actor.currentMember.id))
}
async function liveMember(database: typeof db | GatewayTx, actor: Actor, lock = false) {
  const query = database.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.id, actor.currentMember.id), eq(MemberTable.organizationId, actor.organization.id), isNull(MemberTable.removedAt),
  ))
  const [member] = await (lock ? query.for("update") : query)
  if (!member?.userId) throw new GatewayWriteError(403, "forbidden")
}
function summary(row: Router): GatewayRouterSummary {
  return { id: row.id, name: row.name, status: row.status, ...row.configuration, revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }
}
function values(input: GatewayRouterDefinition) {
  return { name: input.name, status: input.status, configuration: { routes: input.routes, fallbackRouteId: input.fallbackRouteId, minConfidence: input.minConfidence } }
}
async function targets(actor: Actor): Promise<GatewayRouterTarget[]> {
  const providers = await db.select().from(GatewayProviderTable).where(and(eq(GatewayProviderTable.organization_id, actor.organization.id), eq(GatewayProviderTable.status, "active")))
  const result: GatewayRouterTarget[] = []
  for (const provider of providers) {
    if (!isGatewayRouterTargetNpm(readProviderConfigNpm(provider.provider_config))) continue
    const usable = await gatewaySummary(provider, actor.currentMember.id, env.gatewayPublicBaseUrl, false)
    for (const model of usable.models) result.push({ inferenceProviderId: provider.id, model: model.id, name: model.name, providerName: provider.name })
  }
  return result
}
async function validateTargets(actor: Actor, input: GatewayRouterDefinition) {
  if (input.status === "disabled") return
  const available = await targets(actor)
  if (input.routes.some((route) => !available.some((target) => target.inferenceProviderId === route.inferenceProviderId && target.model === route.model))) {
    throw new GatewayWriteError(403, "gateway_router_target_unavailable", "Every target must be a currently usable OpenAI-compatible gateway model alias.")
  }
}
function respond(c: { json: (body: unknown, status: 400 | 403 | 404 | 409) => Response }, error: unknown) {
  if (error instanceof GatewayWriteError) return c.json({ error: error.code, message: error.message }, error.status)
  throw error
}
const privateResponse: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "private, no-store")
  await next()
}
const available: MiddlewareHandler<{ Variables: OrgRouteVariables }> = async (c, next) => {
  const unavailable = gatewayManagementUnavailable()
  if (unavailable) return c.json(unavailable, 403)
  const actor = c.get("organizationContext")
  if (!actor) return c.json({ error: "unauthorized" }, 401)
  try { await liveMember(db, actor) } catch (error) { return respond(c, error) }
  await next()
}

export function registerOrgGatewayRouterRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.use("/v1/gateway-routers", privateResponse)
  app.use("/v1/gateway-routers/*", privateResponse)
  app.get("/v1/gateway-routers", metadata("List your Gateway routers", z.object({ routers: z.array(gatewayRouterSummarySchema) })), orgMemberRoute(), available, async (c) => {
    const rows = await db.select().from(GatewayRouterTable).where(owned(c.get("organizationContext"))).orderBy(desc(GatewayRouterTable.updated_at))
    return c.json({ routers: rows.map(summary) })
  })
  app.get("/v1/gateway-routers/targets", metadata("List usable router targets", z.object({ targets: z.array(gatewayRouterTargetSchema) })), orgMemberRoute(), available, async (c) => {
    try { return c.json({ targets: await targets(c.get("organizationContext")) }) } catch (error) { return respond(c, error) }
  })
  app.get("/v1/gateway-routers/:routerId", metadata("Get your Gateway router", response), orgMemberRoute(), available, paramValidator(params), async (c) => {
    const [row] = await db.select().from(GatewayRouterTable).where(and(owned(c.get("organizationContext")), eq(GatewayRouterTable.id, c.req.valid("param").routerId)))
    if (!row) return c.json({ error: "gateway_router_not_found" }, 404)
    return c.json({ router: summary(row) })
  })
  app.post("/v1/gateway-routers", metadata("Create a Gateway router", response, 201), orgMemberRoute(), available, jsonValidator(gatewayRouterDefinitionSchema), async (c) => {
    try {
      const actor = c.get("organizationContext"), input = c.req.valid("json")
      await validateTargets(actor, input)
      const router = await db.transaction(async (tx) => {
        await liveMember(tx, actor, true)
        const now = new Date()
        const row: Router = { id: createDenTypeId("gatewayRouter"), organization_id: actor.organization.id, created_by_org_membership_id: actor.currentMember.id, ...values(input), revision: 1, created_at: now, updated_at: now }
        await tx.insert(GatewayRouterTable).values(row)
        return summary(row)
      })
      return c.json({ router }, 201)
    } catch (error) { return respond(c, error) }
  })
  app.put("/v1/gateway-routers/:routerId", metadata("Update your Gateway router", response), orgMemberRoute(), available, paramValidator(params), jsonValidator(gatewayRouterUpdateSchema), async (c) => {
    try {
      const actor = c.get("organizationContext"), input = c.req.valid("json"), id = c.req.valid("param").routerId
      const router = await db.transaction(async (tx) => {
        await liveMember(tx, actor, true)
        const predicate = and(owned(actor), eq(GatewayRouterTable.id, id))
        const [row] = await tx.select().from(GatewayRouterTable).where(predicate).for("update")
        if (!row) throw new GatewayWriteError(404, "gateway_router_not_found")
        if (row.revision !== input.revision) throw new GatewayWriteError(409, "gateway_router_revision_conflict")
        await validateTargets(actor, input)
        const updated = { ...row, ...values(input), revision: row.revision + 1, updated_at: new Date() }
        await tx.update(GatewayRouterTable).set({ ...values(input), revision: updated.revision, updated_at: updated.updated_at }).where(and(predicate, eq(GatewayRouterTable.revision, input.revision)))
        return summary(updated)
      })
      return c.json({ router })
    } catch (error) { return respond(c, error) }
  })
  app.delete("/v1/gateway-routers/:routerId", metadata("Delete your Gateway router", undefined, 204), orgMemberRoute(), available, paramValidator(params), async (c) => {
    try {
      const actor = c.get("organizationContext"), id = c.req.valid("param").routerId
      await db.transaction(async (tx) => {
        await liveMember(tx, actor, true)
        const predicate = and(owned(actor), eq(GatewayRouterTable.id, id))
        const [row] = await tx.select().from(GatewayRouterTable).where(predicate).for("update")
        if (!row) throw new GatewayWriteError(404, "gateway_router_not_found")
        await tx.delete(GatewayRouterTable).where(predicate)
      })
      return c.body(null, 204)
    } catch (error) { return respond(c, error) }
  })
}
