import { and, asc, count, eq, inArray, ne } from "@openwork-ee/den-db/drizzle"
import {
  GatewayModelGroupModelTable,
  GatewayModelGroupTable,
  GatewayProviderModelTable,
  GatewayProviderTable,
  LlmProviderModelTable,
  LlmProviderTable,
  OrganizationTable,
  OrgDefaultModelTable,
  TeamMemberTable,
  TeamTable,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { automationModelOptions } from "@openwork/types/automation-models"
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import {
  DEFAULT_MODEL_EVERYONE_SCOPE,
  countDefaultModelConflicts,
  resolveDefaultModel,
  sameDefaultModel,
  type DefaultModelChoice,
  type DefaultModelOption,
  type DefaultModelOptions,
  type DefaultModelSettings,
  type DefaultModelSource,
} from "@openwork/types/den/default-model"
import type { DesktopConfig } from "@openwork/types/den/desktop-policies"
import { db } from "./db.js"
import { gatewayManagementUnavailable } from "./gateway-deployment.js"
import { organizationAllowsManagedModels, readInferenceMetadata } from "./inference.js"
import { gatewaySummary } from "./llm/gateway-matrix.js"
import { gatewayModelConfigurationError } from "./llm/inference-provider-config.js"
import { listAccessibleLlmProviderAccess } from "./routes/org/llm-provider-access.js"

type OrganizationId = DenTypeId<"organization">
type TeamId = DenTypeId<"team">
type MemberId = DenTypeId<"member">
type Database = typeof db | Parameters<Parameters<typeof db["transaction"]>[0]>[0]

export type DesktopDefaultModel = NonNullable<DesktopConfig["defaultModel"]>

export const OPENWORK_MODELS_PROVIDER_ID = "openwork"

function isGatewayProviderId(providerId: string): providerId is DenTypeId<"inferenceProvider"> {
  return providerId.startsWith("ipr_")
}

function isLlmProviderId(providerId: string): providerId is DenTypeId<"llmProvider"> {
  return providerId.startsWith("lpr_")
}

function choiceOf(row: { providerId: string; modelId: string }): DefaultModelChoice {
  return { providerId: row.providerId, modelId: row.modelId }
}

/** OpenWork Models, when the organization has them on and its data agreement allows them. */
async function openWorkModelOptions(organizationId: OrganizationId): Promise<DefaultModelOption[]> {
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, organizationId))
    .limit(1)
  if (!readInferenceMetadata(organization?.metadata ?? null)) return []
  if (!await organizationAllowsManagedModels(organizationId)) return []
  return automationModelOptions(
    [{ id: OPENWORK_MODELS_PROVIDER_ID, source: "openwork", name: "OpenWork Models", models: [] }],
    { includeFreeStarter: false },
  ).map((option) => ({
    providerId: option.providerId,
    modelId: option.modelId,
    providerName: option.providerName,
    modelName: option.modelName,
    logoProviderId: option.logoProviderId ?? OPENWORK_MODELS_PROVIDER_ID,
    source: "openwork" as const,
  }))
}

/** Every model the organization's own providers (`lpr_…`) offer, within each provider's allowlist. */
async function organizationProviderOptions(organizationId: OrganizationId): Promise<DefaultModelOption[]> {
  const providers = await db
    .select({ id: LlmProviderTable.id, source: LlmProviderTable.source, providerId: LlmProviderTable.providerId, name: LlmProviderTable.name, providerConfig: LlmProviderTable.providerConfig })
    .from(LlmProviderTable)
    .where(and(eq(LlmProviderTable.organizationId, organizationId), ne(LlmProviderTable.source, "openwork")))
  if (providers.length === 0) return []
  const models = await db
    .select({ llmProviderId: LlmProviderModelTable.llmProviderId, id: LlmProviderModelTable.modelId, name: LlmProviderModelTable.name })
    .from(LlmProviderModelTable)
    .where(inArray(LlmProviderModelTable.llmProviderId, providers.map((provider) => provider.id)))
  return automationModelOptions(
    providers.map((provider) => ({
      id: provider.id,
      source: provider.source,
      providerId: provider.providerId,
      name: provider.name,
      providerConfig: provider.providerConfig ?? {},
      models: models.filter((model) => model.llmProviderId === provider.id),
    })),
    { includeFreeStarter: false },
  ).map((option) => ({
    providerId: option.providerId,
    modelId: option.modelId,
    providerName: option.providerName,
    modelName: option.modelName,
    logoProviderId: option.logoProviderId ?? option.providerId,
    source: "provider" as const,
  }))
}

/**
 * The AI Gateway's models: each active provider's catalog models that sit in
 * at least one active model group. The model id is the catalog id; members
 * reach it through their own alias.
 */
async function gatewayOptions(organizationId: OrganizationId): Promise<DefaultModelOption[]> {
  if (gatewayManagementUnavailable()) return []
  const providers = await db
    .select()
    .from(GatewayProviderTable)
    .where(and(eq(GatewayProviderTable.organization_id, organizationId), eq(GatewayProviderTable.status, "active")))
  const options: DefaultModelOption[] = []
  for (const provider of providers) {
    const groups = await db
      .select({ id: GatewayModelGroupTable.id })
      .from(GatewayModelGroupTable)
      .where(and(eq(GatewayModelGroupTable.gateway_provider_id, provider.id), eq(GatewayModelGroupTable.status, "active")))
    if (groups.length === 0) continue
    const links = await db
      .select({ modelRowId: GatewayModelGroupModelTable.gateway_provider_model_id })
      .from(GatewayModelGroupModelTable)
      .where(inArray(GatewayModelGroupModelTable.model_group_id, groups.map((group) => group.id)))
    const linked = new Set(links.map((link) => link.modelRowId))
    const models = await db.select().from(GatewayProviderModelTable).where(eq(GatewayProviderModelTable.gateway_provider_id, provider.id))
    const seen = new Set<string>()
    for (const model of models) {
      if (!linked.has(model.id) || seen.has(model.model_id)) continue
      if (provider.model_ids.length > 0 && !provider.model_ids.includes(model.model_id)) continue
      if (gatewayModelConfigurationError(provider.provider_config, [model.model_config])) continue
      seen.add(model.model_id)
      options.push({
        providerId: provider.id,
        modelId: model.model_id,
        providerName: provider.name,
        modelName: model.name,
        logoProviderId: provider.provider_id,
        source: "gateway",
      })
    }
  }
  return options
}

const SOURCE_ORDER: readonly DefaultModelSource[] = ["openwork", "gateway", "provider"]

/** Readers per source; injectable so tests can fail one source without a database. */
export type DefaultModelOptionReaders = Record<DefaultModelSource, (organizationId: OrganizationId) => Promise<DefaultModelOption[]>>

const liveReaders: DefaultModelOptionReaders = {
  openwork: openWorkModelOptions,
  gateway: gatewayOptions,
  provider: organizationProviderOptions,
}

/**
 * Every model the organization can choose as a default, read live from what
 * it has set up. A source that fails is reported, and its models left out,
 * so the others stay choosable.
 */
export async function listDefaultModelOptions(organizationId: OrganizationId, readers: DefaultModelOptionReaders = liveReaders): Promise<DefaultModelOptions> {
  const results = await Promise.all(SOURCE_ORDER.map(async (source) => {
    try {
      return { source, options: await readers[source](organizationId), failed: false }
    } catch (error) {
      console.warn("[default-model] could not read model source", source, error instanceof Error ? error.message : error)
      return { source, options: [], failed: true }
    }
  }))
  return {
    options: results.flatMap((result) => result.options).sort((left, right) =>
      SOURCE_ORDER.indexOf(left.source) - SOURCE_ORDER.indexOf(right.source)
      || left.providerName.localeCompare(right.providerName)
      || left.modelName.localeCompare(right.modelName)),
    unavailableSources: results.flatMap((result) => result.failed ? [result.source] : []),
  }
}

/** Whether a choice is one of the organization's models: "ok", "unknown_model", or "source_unavailable" when its source could not be read. */
export function checkDefaultModelChoice(choice: DefaultModelChoice, options: DefaultModelOptions): "ok" | "unknown_model" | "source_unavailable" {
  if (options.options.some((option) => sameDefaultModel(option, choice))) return "ok"
  const source: DefaultModelSource = choice.providerId === OPENWORK_MODELS_PROVIDER_ID ? "openwork" : isGatewayProviderId(choice.providerId) ? "gateway" : "provider"
  return options.unavailableSources.includes(source) ? "source_unavailable" : "unknown_model"
}

/** The organization default and every team's override, teams by name, with each team's size and conflicts. */
export async function listDefaultModelSettings(organizationId: OrganizationId): Promise<Omit<DefaultModelSettings, "canEdit">> {
  const [rows, teams] = await Promise.all([
    db.select().from(OrgDefaultModelTable).where(eq(OrgDefaultModelTable.organizationId, organizationId)),
    db.select({ id: TeamTable.id, name: TeamTable.name }).from(TeamTable).where(eq(TeamTable.organizationId, organizationId)).orderBy(asc(TeamTable.name)),
  ])
  const membershipRows = teams.length > 0
    ? await db
      .select({ teamId: TeamMemberTable.teamId, memberId: TeamMemberTable.orgMembershipId })
      .from(TeamMemberTable)
      .where(inArray(TeamMemberTable.teamId, teams.map((team) => team.id)))
    : []
  const memberships = membershipRows.flatMap((row) => row.memberId ? [{ teamId: row.teamId, memberId: row.memberId }] : [])
  const everyone = rows.find((row) => row.scopeKey === DEFAULT_MODEL_EVERYONE_SCOPE)
  const byTeam = new Map(rows.flatMap((row) => row.teamId ? [[row.teamId, choiceOf(row)] as const] : []))
  const teamModels = teams.map((team) => ({ teamId: team.id, model: byTeam.get(team.id) ?? null }))
  const conflicts = countDefaultModelConflicts({ teams: teamModels, memberships })
  return {
    everyone: everyone ? choiceOf(everyone) : null,
    teams: teams.map((team) => ({
      teamId: team.id,
      name: team.name,
      memberCount: memberships.filter((membership) => membership.teamId === team.id).length,
      model: byTeam.get(team.id) ?? null,
      conflictingMemberCount: conflicts.get(team.id) ?? 0,
    })),
  }
}

export async function findOrganizationTeamForDefaultModel(organizationId: OrganizationId, teamId: TeamId) {
  const [team] = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamTable)
    .where(and(eq(TeamTable.organizationId, organizationId), eq(TeamTable.id, teamId)))
    .limit(1)
  if (!team) return null
  const [members] = await db.select({ total: count(TeamMemberTable.orgMembershipId) }).from(TeamMemberTable).where(eq(TeamMemberTable.teamId, team.id))
  return { ...team, memberCount: Number(members?.total ?? 0) }
}

/**
 * Sets or clears one scope's model: the organization default (teamId null) or
 * one team's override. Null clears it: no organization default, or the team
 * uses the organization default again.
 */
export async function saveDefaultModel(input: {
  organizationId: OrganizationId
  teamId: TeamId | null
  model: DefaultModelChoice | null
  updatedByOrgMemberId: MemberId
}): Promise<void> {
  const scopeKey = input.teamId ?? DEFAULT_MODEL_EVERYONE_SCOPE
  const now = new Date()
  await db.transaction(async (tx) => {
    const scope = and(eq(OrgDefaultModelTable.organizationId, input.organizationId), eq(OrgDefaultModelTable.scopeKey, scopeKey))
    const [existing] = await tx.select({ id: OrgDefaultModelTable.id }).from(OrgDefaultModelTable).where(scope).limit(1).for("update")
    if (!input.model) {
      if (existing) await tx.delete(OrgDefaultModelTable).where(eq(OrgDefaultModelTable.id, existing.id))
      return
    }
    if (existing) {
      await tx
        .update(OrgDefaultModelTable)
        .set({ providerId: input.model.providerId, modelId: input.model.modelId, updatedByOrgMemberId: input.updatedByOrgMemberId, updatedAt: now })
        .where(eq(OrgDefaultModelTable.id, existing.id))
      return
    }
    await tx.insert(OrgDefaultModelTable).values({
      id: createDenTypeId("orgDefaultModel"),
      organizationId: input.organizationId,
      teamId: input.teamId,
      scopeKey,
      providerId: input.model.providerId,
      modelId: input.model.modelId,
      updatedByOrgMemberId: input.updatedByOrgMemberId,
      createdAt: now,
      updatedAt: now,
    })
  })
}

/** Removes a team's override inside the transaction that deletes the team. */
export async function deleteTeamDefaultModel(database: Database, teamId: TeamId): Promise<void> {
  await database.delete(OrgDefaultModelTable).where(eq(OrgDefaultModelTable.teamId, teamId))
}

/** Removes every default model of an organization inside the transaction that deletes it. */
export async function deleteOrganizationDefaultModels(database: Database, organizationId: OrganizationId): Promise<void> {
  await database.delete(OrgDefaultModelTable).where(eq(OrgDefaultModelTable.organizationId, organizationId))
}

/**
 * The model reference this member's desktop uses for a choice, or null when
 * the member cannot use it: OpenWork Models and organization providers need
 * the member's access; an AI Gateway model becomes the member's own alias.
 */
async function memberModelReference(input: { organizationId: OrganizationId; memberId: MemberId; teamIds: TeamId[] }, choice: DefaultModelChoice): Promise<{ providerID: string; modelID: string } | null> {
  if (isGatewayProviderId(choice.providerId)) {
    if (gatewayManagementUnavailable()) return null
    const [provider] = await db
      .select()
      .from(GatewayProviderTable)
      .where(and(eq(GatewayProviderTable.id, choice.providerId), eq(GatewayProviderTable.organization_id, input.organizationId)))
      .limit(1)
    if (!provider || provider.status !== "active") return null
    const summary = await gatewaySummary(provider, input.memberId, "", false)
    const alias = summary.models.find((model) => model.upstreamModelId === choice.modelId)
    return alias ? { providerID: provider.id, modelID: alias.id } : null
  }

  const access = await listAccessibleLlmProviderAccess({ organizationId: input.organizationId, currentMemberId: input.memberId, teamIds: input.teamIds })
  const accessible = [...new Set(access.map((entry) => entry.llmProviderId))]
  if (accessible.length === 0) return null
  if (choice.providerId === OPENWORK_MODELS_PROVIDER_ID) {
    if (!Object.entries(INFERENCE_MODEL_ALIASES).some(([id, model]) => id === choice.modelId && model.enabled)) return null
    if (!await organizationAllowsManagedModels(input.organizationId)) return null
    const [openwork] = await db
      .select({ id: LlmProviderTable.id })
      .from(LlmProviderTable)
      .where(and(eq(LlmProviderTable.organizationId, input.organizationId), eq(LlmProviderTable.source, "openwork"), inArray(LlmProviderTable.id, accessible)))
      .limit(1)
    return openwork ? { providerID: OPENWORK_MODELS_PROVIDER_ID, modelID: choice.modelId } : null
  }
  if (!isLlmProviderId(choice.providerId) || !accessible.includes(choice.providerId)) return null
  const [model] = await db
    .select({ id: LlmProviderModelTable.modelId })
    .from(LlmProviderModelTable)
    .where(and(eq(LlmProviderModelTable.llmProviderId, choice.providerId), eq(LlmProviderModelTable.modelId, choice.modelId)))
    .limit(1)
  return model ? { providerID: choice.providerId, modelID: model.id } : null
}

/**
 * The default model a member's desktop starts new chats with: their teams'
 * override, else the organization default (see resolveDefaultModel). Null
 * when there is none or the member cannot use the resolved model; the desktop
 * then keeps its own behaviour.
 */
export async function readDefaultModelForMember(input: { organizationId: OrganizationId; memberId: MemberId }): Promise<DesktopDefaultModel | null> {
  const rows = await db.select().from(OrgDefaultModelTable).where(eq(OrgDefaultModelTable.organizationId, input.organizationId))
  if (rows.length === 0) return null
  const teams = await db
    .select({ id: TeamTable.id, name: TeamTable.name })
    .from(TeamMemberTable)
    .innerJoin(TeamTable, eq(TeamMemberTable.teamId, TeamTable.id))
    .where(and(eq(TeamTable.organizationId, input.organizationId), eq(TeamMemberTable.orgMembershipId, input.memberId)))
  const everyone = rows.find((row) => row.scopeKey === DEFAULT_MODEL_EVERYONE_SCOPE)
  const resolved = resolveDefaultModel({
    everyone: everyone ? choiceOf(everyone) : null,
    teams: teams.map((team) => {
      const row = rows.find((entry) => entry.teamId === team.id)
      return { name: team.name, model: row ? choiceOf(row) : null }
    }),
  })
  if (!resolved) return null
  const reference = await memberModelReference({ ...input, teamIds: teams.map((team) => team.id) }, resolved.model)
  if (!reference) return null
  return resolved.from.kind === "team"
    ? { ...reference, source: "team", teamName: resolved.from.teamName }
    : { ...reference, source: "organization" }
}

/**
 * What `/v1/me/desktop-config` sends as `defaultModel`: nothing while the
 * feature is off (the stored choices are not even read), and nothing when the
 * lookup fails, so desktops keep their own default.
 */
export async function desktopConfigDefaultModel(
  input: { organizationId: OrganizationId; memberId: MemberId },
  read: typeof readDefaultModelForMember = readDefaultModelForMember,
): Promise<DesktopDefaultModel | null> {
  try {
    return await read({ organizationId: input.organizationId, memberId: input.memberId })
  } catch (error) {
    console.warn("[default-model] could not resolve a member's default model", error instanceof Error ? error.message : error)
    return null
  }
}
