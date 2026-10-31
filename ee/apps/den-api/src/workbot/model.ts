import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { readWorkbotModel, WORKBOT_DEFAULT_MODEL_ID } from "@openwork/types/den/workbot-settings"
import { db } from "../db.js"
import { cloudAgentGatewayCatalog } from "./gateway-model.js"
import { createHeadlessRunnerClient, defaultHeadlessRunnerDeps, type HeadlessModelCatalog } from "../headless-runner/client.js"
import { workbotManagedLunaRoutable, workbotManagedLunaState } from "./managed-luna.js"

/**
 * The organization's default model for its cloud agents on the headless runner: Workbot, the Slack assistant, and
 * cloud Automations set to the cloud default. Admins choose it in Den › Manage › Workbot.
 *
 * It is a default, not a lock: an Automation with its own model keeps it. Null means the runner's default. A saved
 * model the runner no longer serves also gives null, so a removed model never breaks every chat.
 * One organization-wide value; per-team overrides could later be resolved on top of it here.
 */
export type OrganizationModelPolicy = {
  /** Callers use `model`; false is reserved for an unavailable policy read. */
  enabled: boolean
  /** The model to send to the runner; null means the runner's default. Always null when not enabled. */
  model: string | null
}

const CATALOG_CACHE_MS = 60_000
let cachedCatalog: { at: number; value: Promise<HeadlessModelCatalog | null> } | null = null

/** The runner's model catalog, shared for a minute: every chat turn, Slack run and Automation run reads it. */
export function headlessModelCatalog(now = Date.now()): Promise<HeadlessModelCatalog | null> {
  if (cachedCatalog && now - cachedCatalog.at < CATALOG_CACHE_MS) return cachedCatalog.value
  const deps = defaultHeadlessRunnerDeps()
  const value = deps ? createHeadlessRunnerClient(deps).listModels().catch(() => null) : Promise.resolve(null)
  cachedCatalog = { at: now, value }
  // A failed read is not kept: the next caller asks again.
  void value.then((catalog) => {
    if (!catalog && cachedCatalog?.value === value) cachedCatalog = null
  })
  return value
}

/** Forget the cached catalog, so the admin page and the next turn see a change at once. */
export function forgetHeadlessModelCatalog() {
  cachedCatalog = null
}

/** The organization's saved choice, read fresh so an admin's change applies to the next turn. */
export async function readOrganizationDefaultModel(organizationId: string): Promise<string | null> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return readWorkbotModel(organization?.metadata)
}

export type CloudModelActor = { organizationId: string; userId: string }

/** One catalog boundary for settings and execution: the actor's AI Gateway models. Never shared across actors. */
export async function cloudAgentModelCatalog(actor: CloudModelActor): Promise<HeadlessModelCatalog> {
  return cloudAgentGatewayCatalog(actor)
}

/** Workbot's managed starter is separate from custom cloud-agent defaults, as on desktop. */
export async function workbotModelCatalog(actor: CloudModelActor): Promise<HeadlessModelCatalog | null> {
  const [catalog, state] = await Promise.all([
    cloudAgentModelCatalog(actor).catch(() => null), workbotManagedLunaState(actor),
  ])
  const ready = state.paid ? state.paidReady : workbotManagedLunaRoutable(state)
  // Without included access the workspace's Gateway default stays the default. When the Gateway cannot be read
  // either, nothing is verified: report that (null) instead of an empty catalog that reads as "unavailable".
  if (!workbotManagedLunaRoutable(state)) return catalog
  return { defaultModel: state.model, verified: true, models: [
    ...(ready ? [{ id: state.model, name: state.paid ? "OpenWork: GPT-6 Luna" : "Auto", provider: state.paid ? "openwork" : "openwork-free" }] : []),
    ...(catalog?.models ?? []),
  ] }
}

/** Selection only. Authorization belongs after the shared client's persisted-turn pin, at credential minting. */
export async function organizationCloudModelSelection(actor: CloudModelActor, fallback: string | null = null): Promise<string | null> {
  const chosen = await readOrganizationDefaultModel(actor.organizationId)
  return chosen ?? fallback ?? (await cloudAgentGatewayCatalog(actor)).defaultModel
}

/**
 * An organization default selects a model; it never grants inference access. Every caller must have its own
 * usable AI Gateway assignment, and unavailable choices never fall back to a shared key.
 */
export async function organizationCloudModel(actor: CloudModelActor, fallback: string | null = null): Promise<string | null> {
  const catalog = await cloudAgentGatewayCatalog(actor)
  const chosen = await readOrganizationDefaultModel(actor.organizationId)
  const model = chosen ?? fallback ?? catalog.defaultModel
  if (!model || !catalog.models.some((entry) => entry.id === model)) throw new Error("cloud_model_unavailable")
  return model
}

/** The chosen model when the runner serves it (or can't say right now), otherwise null: the runner's default. */
export function servableModel(chosen: string | null, catalog: HeadlessModelCatalog | null): string | null {
  if (!chosen) return null
  if (!catalog) return chosen
  return catalog.models.some((entry) => entry.id === chosen) ? chosen : null
}

/** What the admin page shows: the saved model, whether the caller's AI Gateway still serves it, and what can be chosen. */
export function workbotSettingsView(chosen: string | null, catalog: HeadlessModelCatalog | null) {
  const defaultReadiness = catalog === null ? "unverified" : catalog.models.some((entry) => entry.id === catalog.defaultModel) ? "available" : "unavailable"
  return {
    model: chosen,
    gatewayModels: true,
    // Same fallback as /v1/workbot/session, so the page names the model Workbot will actually ask for.
    defaultModel: catalog?.defaultModel || WORKBOT_DEFAULT_MODEL_ID,
    defaultReadiness,
    models: catalog?.models ?? [],
    modelAvailable: chosen === null || catalog === null || catalog.models.some((entry) => entry.id === chosen),
    runnerReachable: catalog !== null,
  }
}

/** A model may be saved only when the runner serves it right now; null (the runner's default) always may. */
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

/** The model the organization's cloud agents answer with, or null for the runner's default. */
export async function organizationDefaultModel(
  organizationId: string,
  deps: Partial<OrganizationModelPolicyDeps> = {},
): Promise<string | null> {
  return (await organizationModelPolicy(organizationId, deps)).model
}
