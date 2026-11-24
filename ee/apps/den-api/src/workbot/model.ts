import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotModel, WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import { db } from "../db.js"
import { cloudAgentGatewayCatalog } from "./gateway-model.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, type HeadlessModelCatalog } from "../headless-runner/client.js"
import { workbotManagedLunaRoutable, workbotManagedLunaState } from "./managed-luna.js"
import { resolveMemberWorkbotSettings } from "./team-settings.js"

export type OrganizationModelPolicy = {
  enabled: boolean
  model: string | null
}

const CATALOG_CACHE_MS = 60_000
let cachedCatalog: { at: number; value: Promise<HeadlessModelCatalog | null> } | null = null

export function headlessModelCatalog(now = Date.now()): Promise<HeadlessModelCatalog | null> {
  if (cachedCatalog && now - cachedCatalog.at < CATALOG_CACHE_MS) return cachedCatalog.value
  const deps = defaultHeadlessRunnerDeps()
  const value = deps ? createHeadlessRunnerClient(deps).listModels().catch(() => null) : Promise.resolve(null)
  cachedCatalog = { at: now, value }
  void value.then((catalog) => {
    if (!catalog && cachedCatalog?.value === value) cachedCatalog = null
  })
  return value
}

export function forgetHeadlessModelCatalog() {
  cachedCatalog = null
}

export async function readOrganizationDefaultModel(organizationId: string): Promise<string | null> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return readWorkbotModel(organization?.metadata)
}

export type CloudModelActor = { organizationId: string; userId: string; memberId?: string }

async function readActorDefaultModel(actor: CloudModelActor): Promise<string | null> {
  return (await resolveMemberWorkbotSettings({ organizationId: actor.organizationId, userId: actor.userId, memberId: actor.memberId })).model
}

export async function cloudAgentModelCatalog(actor: CloudModelActor): Promise<HeadlessModelCatalog> {
  return cloudAgentGatewayCatalog(actor)
}

export async function workbotModelCatalog(actor: CloudModelActor): Promise<HeadlessModelCatalog | null> {
  const [catalog, state] = await Promise.all([
    cloudAgentModelCatalog(actor).catch(() => null), workbotManagedLunaState(actor),
  ])
  const ready = state.paid ? state.paidReady : workbotManagedLunaRoutable(state)
  if (!workbotManagedLunaRoutable(state)) return catalog
  return { defaultModel: state.model, verified: true, models: [
    ...(ready ? [{ id: state.model, name: state.paid ? "OpenWork: GPT-6 Luna" : "Auto", provider: state.paid ? "openwork" : "openwork-free" }] : []),
    ...(catalog?.models ?? []),
  ] }
}

export async function organizationCloudModelSelection(actor: CloudModelActor, fallback: string | null = null): Promise<string | null> {
  const chosen = await readActorDefaultModel(actor)
  return chosen ?? fallback ?? (await cloudAgentGatewayCatalog(actor)).defaultModel
}

export async function organizationCloudModel(actor: CloudModelActor, fallback: string | null = null): Promise<string | null> {
  const catalog = await cloudAgentGatewayCatalog(actor)
  const chosen = await readActorDefaultModel(actor)
  const model = chosen ?? fallback ?? catalog.defaultModel
  if (!model || !catalog.models.some((entry) => entry.id === model)) throw new Error("cloud_model_unavailable")
  return model
}

export function servableModel(chosen: string | null, catalog: HeadlessModelCatalog | null): string | null {
  if (!chosen) return null
  if (!catalog) return chosen
  return catalog.models.some((entry) => entry.id === chosen) ? chosen : null
}

export function workbotSettingsView(chosen: string | null, catalog: HeadlessModelCatalog | null) {
  const defaultReadiness = catalog === null ? "unverified" : catalog.models.some((entry) => entry.id === catalog.defaultModel) ? "available" : "unavailable"
  return {
    model: chosen,
    gatewayModels: true,
    defaultModel: catalog?.defaultModel || WORKBOT_DEFAULT_MODEL_ID,
    defaultReadiness,
    models: catalog?.models ?? [],
    modelAvailable: chosen === null || catalog === null || catalog.models.some((entry) => entry.id === chosen),
    runnerReachable: catalog !== null,
  }
}

export function checkWorkbotModelChoice(model: string | null, catalog: HeadlessModelCatalog | null): "ok" | "unknown_model" | "runner_unavailable" {
  if (model === null) return "ok"
  if (!catalog || catalog.verified !== true) return "runner_unavailable"
  return catalog.models.some((entry) => entry.id === model) ? "ok" : "unknown_model"
}

export type OrganizationModelPolicyDeps = {
  chosenModel: (organizationId: string) => Promise<string | null>
  catalog: () => Promise<HeadlessModelCatalog | null>
}

const defaultDeps: OrganizationModelPolicyDeps = {
  chosenModel: readOrganizationDefaultModel,
  catalog: () => headlessModelCatalog(),
}

export async function organizationModelPolicy(
  organizationId: string,
  deps: Partial<OrganizationModelPolicyDeps> = {},
): Promise<OrganizationModelPolicy> {
  const { chosenModel, catalog } = { ...defaultDeps, ...deps }
  const chosen = await chosenModel(organizationId)
  return { enabled: true, model: chosen ? servableModel(chosen, await catalog()) : null }
}

export async function organizationDefaultModel(
  organizationId: string,
  deps: Partial<OrganizationModelPolicyDeps> = {},
): Promise<string | null> {
  return (await organizationModelPolicy(organizationId, deps)).model
}
