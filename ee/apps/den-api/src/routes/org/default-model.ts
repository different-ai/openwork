import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  GatewayCredentialSetTable,
  GatewayModelGroupTable,
  GatewayProviderAccessTable,
  GatewayProviderModelTable,
  GatewayProviderTable,
  OrganizationDefaultModelTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import {
  type MemberDefaultModel,
  organizationDefaultModelInputSchema,
  organizationDefaultModelResponseSchema,
  type OrganizationDefaultModelResponse,
} from "@openwork/types/den/default-model"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { resolvePublicApiBaseUrl } from "../../capability-sources/generic-oauth.js"
import { db } from "../../db.js"
import { env } from "../../env.js"
import { gatewaySummary } from "../../llm/gateway-matrix.js"
import { effectiveGatewayGrants, memberGatewayTeams } from "../../llm/inference-provider-lifecycle.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { emptyResponse, forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdminRole, orgAccessFailureStatus } from "./shared.js"

const responseDocumentSchema = organizationDefaultModelResponseSchema.meta({ ref: "OrganizationDefaultModel" })
const inputDocumentSchema = organizationDefaultModelInputSchema.meta({ ref: "OrganizationDefaultModelInput" })
const defaultModelErrorSchema = z.object({ error: z.enum(["default_model_not_found"]), message: z.string() }).meta({ ref: "DefaultModelError" })
const ADMIN_MESSAGE = "Only workspace owners and admins can choose the default model."
const NOT_FOUND_MESSAGE = "That model isn't offered by one of this organization's providers."

type Actor = NonNullable<OrgRouteVariables["organizationContext"]>

/** Whether the member reaches this provider through an active model group and credential set. */
async function memberCanUseProvider(provider: typeof GatewayProviderTable.$inferSelect, memberId: Actor["currentMember"]["id"]) {
  if (provider.status !== "active") return false
  const teams = await memberGatewayTeams(db, provider.organization_id, memberId)
  const grants = await db.select({ grant: GatewayProviderAccessTable }).from(GatewayProviderAccessTable)
    .innerJoin(GatewayModelGroupTable, and(eq(GatewayModelGroupTable.id, GatewayProviderAccessTable.model_group_id), eq(GatewayModelGroupTable.gateway_provider_id, provider.id), eq(GatewayModelGroupTable.status, "active")))
    .innerJoin(GatewayCredentialSetTable, and(eq(GatewayCredentialSetTable.id, GatewayProviderAccessTable.credential_set_id), eq(GatewayCredentialSetTable.gateway_provider_id, provider.id), eq(GatewayCredentialSetTable.status, "active")))
    .where(eq(GatewayProviderAccessTable.gateway_provider_id, provider.id))
  return effectiveGatewayGrants(grants.map((row) => row.grant), memberId, teams.map((team) => team.id)).length > 0
}

/**
 * The saved default as this member can select it: the routed model id from
 * their own grants, and whether it waits on their own sign-in. Null when the
 * member has no access to it.
 */
async function resolveForMember(actor: Actor, request: Request, row: typeof OrganizationDefaultModelTable.$inferSelect): Promise<MemberDefaultModel | null> {
  const [provider] = await db.select().from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.id, row.inferenceProviderId), eq(GatewayProviderTable.organization_id, actor.organization.id)))
  if (!provider || !await memberCanUseProvider(provider, actor.currentMember.id)) return null
  const summary = await gatewaySummary(provider, actor.currentMember.id, resolvePublicApiBaseUrl(request, env.apiPublicUrl), false)
  const ready = summary.models.find((model) => model.upstreamModelId === row.modelId)
  if (ready) return { providerId: provider.id, modelId: ready.id, name: ready.name, needsSignIn: false }
  const pending = summary.authorizationRequests.flatMap((entry) => entry.models ?? []).find((model) => model.upstreamModelId === row.modelId)
  return pending ? { providerId: provider.id, modelId: pending.id, name: pending.name, needsSignIn: true } : null
}

async function readDefault(actor: Actor, request: Request): Promise<OrganizationDefaultModelResponse> {
  const [row] = await db.select().from(OrganizationDefaultModelTable).where(eq(OrganizationDefaultModelTable.organizationId, actor.organization.id))
  if (!row) return { configured: null, defaultModel: null }
  const [model] = await db.select({ name: GatewayProviderModelTable.name }).from(GatewayProviderModelTable)
    .where(and(eq(GatewayProviderModelTable.gateway_provider_id, row.inferenceProviderId), eq(GatewayProviderModelTable.model_id, row.modelId)))
  return {
    configured: { providerId: row.inferenceProviderId, modelId: row.modelId, name: model?.name ?? null },
    defaultModel: await resolveForMember(actor, request, row),
  }
}

export function registerOrgDefaultModelRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get("/v1/org/default-model", describeRoute({
    tags: ["Organizations"],
    summary: "Get the organization's default model for new chats",
    description: "Returns the model the organization's admins chose for new chats, and the same model resolved for the caller: the routed model id their access grants and whether it needs their own sign-in first. Any member can read it; defaultModel is null when the caller has no access to the chosen model or none is set.",
    responses: {
      200: jsonResponse("The organization's default model.", responseDocumentSchema),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
      403: jsonResponse("Not a member of this organization.", forbiddenSchema),
    },
  }), orgMemberRoute(), async (c) => {
    const actor = c.get("organizationContext")
    c.header("Cache-Control", "no-store")
    return c.json(await readDefault(actor, c.req.raw))
  })

  app.put("/v1/org/default-model", describeRoute({
    tags: ["Organizations"],
    summary: "Choose the organization's default model for new chats",
    description: "Sets the model everyone starts on in a new chat. The model must be one of the catalog models of an AI Gateway provider in this organization. People can still pick another model. Requires owner or admin.",
    responses: {
      200: jsonResponse("The saved default.", responseDocumentSchema),
      400: jsonResponse("Invalid request.", invalidRequestSchema),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
      403: jsonResponse("Only owners and admins can choose the default.", forbiddenSchema),
      404: jsonResponse("The model isn't offered by a provider in this organization.", defaultModelErrorSchema),
    },
  }), orgMemberRoute(), jsonValidator(inputDocumentSchema), async (c) => {
    const permission = ensureOrganizationAdminRole(c, ADMIN_MESSAGE)
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    const actor = c.get("organizationContext")
    const input = c.req.valid("json")
    let providerId: typeof GatewayProviderTable.$inferSelect.id
    try {
      providerId = normalizeDenTypeId("inferenceProvider", input.providerId)
    } catch {
      return c.json({ error: "default_model_not_found" as const, message: NOT_FOUND_MESSAGE }, 404)
    }
    const [model] = await db.select({ id: GatewayProviderModelTable.id }).from(GatewayProviderModelTable)
      .innerJoin(GatewayProviderTable, eq(GatewayProviderTable.id, GatewayProviderModelTable.gateway_provider_id))
      .where(and(
        eq(GatewayProviderTable.id, providerId),
        eq(GatewayProviderTable.organization_id, actor.organization.id),
        eq(GatewayProviderModelTable.model_id, input.modelId),
      ))
    if (!model) return c.json({ error: "default_model_not_found" as const, message: NOT_FOUND_MESSAGE }, 404)
    const values = { inferenceProviderId: providerId, modelId: input.modelId, updatedByOrgMemberId: actor.currentMember.id }
    await db.insert(OrganizationDefaultModelTable).values({ organizationId: actor.organization.id, ...values })
      .onDuplicateKeyUpdate({ set: values })
    return c.json(await readDefault(actor, c.req.raw))
  })

  app.delete("/v1/org/default-model", describeRoute({
    tags: ["Organizations"],
    summary: "Clear the organization's default model",
    description: "Removes the default for new chats. People keep their own picks; everyone else starts on the free starter model if policy allows it. Requires owner or admin.",
    responses: {
      204: emptyResponse("Cleared."),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
      403: jsonResponse("Only owners and admins can choose the default.", forbiddenSchema),
    },
  }), orgMemberRoute(), async (c) => {
    const permission = ensureOrganizationAdminRole(c, ADMIN_MESSAGE)
    if (!permission.ok) return c.json(permission.response, orgAccessFailureStatus(permission.response))
    const actor = c.get("organizationContext")
    await db.delete(OrganizationDefaultModelTable).where(eq(OrganizationDefaultModelTable.organizationId, actor.organization.id))
    return c.body(null, 204)
  })
}
