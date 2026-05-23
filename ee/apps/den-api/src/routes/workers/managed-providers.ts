import { eq, inArray } from "@openwork-ee/den-db/drizzle"
import { LlmProviderModelTable, LlmProviderTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { paramValidator, requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { memberHasRole } from "../org/shared.js"
import { fetchWorkerRuntimeJson, getWorkerByIdForOrg, parseWorkerIdParam, type WorkerId, type WorkerRouteVariables, workerIdParamSchema } from "./shared.js"

type LlmProviderRow = typeof LlmProviderTable.$inferSelect
type LlmProviderModelRow = typeof LlmProviderModelTable.$inferSelect
type OrganizationId = LlmProviderRow["organizationId"]

export type ManagedProviderSyncProvider = {
  id: string
  providerId: string
  name: string
  source: LlmProviderRow["source"]
  credentialKind: LlmProviderRow["credentialKind"]
  providerConfig: Record<string, unknown>
  models: Array<{ id: string; name: string; config: Record<string, unknown> }>
  apiKey?: string
  opencodeAuth?: string
  revision: string
}

type ManagedProviderRouteDeps = {
  middlewares?: never[]
  getWorker?: (workerId: WorkerId, orgId: OrganizationId) => Promise<{ id: WorkerId } | null>
  listProviders?: (orgId: OrganizationId) => Promise<ManagedProviderSyncProvider[]>
  pushRuntime?: (workerId: WorkerId, payload: { providers: ManagedProviderSyncProvider[]; revision: string }) => Promise<{ ok: boolean; status: number; payload: unknown }>
}

const managedProviderSyncResponseSchema = z.object({
  status: z.enum(["applied", "failed"]),
  providerCount: z.number().int().min(0),
  revision: z.string(),
  reason: z.string().optional(),
}).meta({ ref: "ManagedProviderSyncResponse" })

export function canSyncManagedProviders(payload: { currentMember: { isOwner: boolean; role: string } }) {
  return payload.currentMember.isOwner || memberHasRole(payload.currentMember.role, "admin")
}

function credentialPresent(provider: Pick<LlmProviderRow, "credentialKind" | "apiKey" | "opencodeAuth">) {
  return provider.credentialKind === "opencode_oauth"
    ? Boolean(provider.opencodeAuth?.trim())
    : Boolean(provider.apiKey?.trim())
}

function revisionForProvider(provider: Pick<LlmProviderRow, "id" | "updatedAt" | "credentialKind">, models: LlmProviderModelRow[]) {
  return [
    provider.id,
    provider.credentialKind,
    provider.updatedAt instanceof Date ? provider.updatedAt.toISOString() : String(provider.updatedAt),
    models.map((model) => `${model.modelId}:${model.name}`).sort().join(","),
  ].join(":")
}

export function computeManagedProviderRevision(providers: Pick<ManagedProviderSyncProvider, "id" | "revision">[]) {
  return providers.map((provider) => `${provider.id}:${provider.revision}`).sort().join("|") || "empty"
}

export function sanitizeManagedProviderSyncFailure(payload: unknown) {
  return "Worker provider sync failed."
}

export async function listManagedProviderSyncProviders(organizationId: OrganizationId) {
  const providers = await db
    .select()
    .from(LlmProviderTable)
    .where(eq(LlmProviderTable.organizationId, organizationId))

  const eligible = providers.filter(credentialPresent)
  if (!eligible.length) return []

  const models = await db
    .select()
    .from(LlmProviderModelTable)
    .where(inArray(LlmProviderModelTable.llmProviderId, eligible.map((provider) => provider.id)))

  return eligible.map((provider) => {
    const providerModels = models.filter((model) => model.llmProviderId === provider.id)
    return {
      id: provider.id,
      providerId: provider.providerId,
      name: provider.name,
      source: provider.source,
      credentialKind: provider.credentialKind,
      providerConfig: provider.providerConfig,
      models: providerModels.map((model) => ({ id: model.modelId, name: model.name, config: model.modelConfig })),
      ...(provider.credentialKind === "api_key" && provider.apiKey ? { apiKey: provider.apiKey } : {}),
      ...(provider.credentialKind === "opencode_oauth" && provider.opencodeAuth ? { opencodeAuth: provider.opencodeAuth } : {}),
      revision: revisionForProvider(provider, providerModels),
    }
  })
}

export function registerManagedProviderSyncRoutes(app: Hono<{ Variables: WorkerRouteVariables }>, deps: ManagedProviderRouteDeps = {}) {
  const routeMiddlewares = deps.middlewares ?? [requireUserMiddleware, resolveOrganizationContextMiddleware, paramValidator(workerIdParamSchema)]
  const getWorker = deps.getWorker ?? getWorkerByIdForOrg
  const listProviders = deps.listProviders ?? listManagedProviderSyncProviders
  const pushRuntime = deps.pushRuntime ?? ((workerId, payload) => fetchWorkerRuntimeJson({
    workerId,
    path: "/managed-providers/sync",
    method: "POST",
    body: payload,
  }))

  app.post(
    "/v1/workers/:id/managed-providers/sync",
    describeRoute({
      tags: ["Workers", "Managed Providers"],
      summary: "Sync managed providers to worker runtime",
      description: "Applies organization-managed provider config/auth to a static worker through the host-token runtime channel.",
      responses: {
        200: jsonResponse("Managed providers applied successfully.", managedProviderSyncResponseSchema),
        400: jsonResponse("The worker path parameters were invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in to sync providers.", unauthorizedSchema),
        403: jsonResponse("Only organization owners and admins can sync providers.", forbiddenSchema),
        404: jsonResponse("The worker could not be found.", notFoundSchema),
      },
    }),
    ...(routeMiddlewares as never[]),
    async (c) => {
      const orgId = c.get("activeOrganizationId")
      const organizationContext = c.get("organizationContext")
      const params = c.req.valid("param" as never) as { id: string }

      if (!orgId) return c.json({ error: "worker_not_found" }, 404)
      if (!organizationContext || !canSyncManagedProviders(organizationContext)) {
        return c.json({ error: "forbidden", message: "Only organization owners and admins can sync managed providers." }, 403)
      }

      let workerId: WorkerId
      try {
        workerId = parseWorkerIdParam(params.id)
      } catch {
        return c.json({ error: "worker_not_found" }, 404)
      }

      const normalizedOrgId = normalizeDenTypeId("organization", orgId)
      const worker = await getWorker(workerId, normalizedOrgId)
      if (!worker) return c.json({ error: "worker_not_found" }, 404)

      const providers = await listProviders(normalizedOrgId)
      const revision = computeManagedProviderRevision(providers)
      if (providers.length === 0) {
        return c.json({ status: "applied", providerCount: 0, revision })
      }

      const runtime = await pushRuntime(worker.id, { providers, revision })
      if (!runtime.ok) {
        return c.json({
          status: "failed",
          providerCount: providers.length,
          revision,
          reason: sanitizeManagedProviderSyncFailure(runtime.payload),
        }, 502)
      }

      return c.json({ status: "applied", providerCount: providers.length, revision })
    },
  )
}
