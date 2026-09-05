import { and, eq, inArray, isNull, or } from "@openwork-ee/den-db/drizzle"
import {
  LlmProviderAccessTable,
  LlmProviderModelTable,
  LlmProviderTable,
  MemberTable,
  TeamMemberTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import { INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import { db } from "../db.js"
import { calculateDesktopPolicyForOrgMember } from "../desktop-policies.js"

type ProviderId = typeof LlmProviderTable.$inferSelect.id
type MemberId = typeof MemberTable.$inferSelect.id

export type AutomationAuthorityMember = {
  id: MemberId
}

export type AutomationAuthorityProvider = {
  id: ProviderId
  source: "models_dev" | "custom" | "openwork"
  name: string
}

export type AutomationAuthorityModel = {
  modelId: string
  name: string
}

export type AutomationModelSelection = {
  providerId: string
  modelId: string
  variant?: string | null
}

export type ResolvedAutomationModel = AutomationModelSelection & {
  accessKind: "free" | "openwork_managed" | "authorized_custom"
  providerRecordId: string | null
  providerName: string
  modelName: string
}

export type AutomationAuthorityFailure = {
  ok: false
  code: "owner_membership_lost" | "model_access_lost" | "provider_unavailable"
  message: string
}

export type AutomationAuthorityResult =
  | { ok: true; value: ResolvedAutomationModel }
  | AutomationAuthorityFailure

export type AutomationModelAuthorityStore = {
  findActiveMember(input: { organizationId: string; ownerMemberId: string }): Promise<AutomationAuthorityMember | null>
  findOpenWorkProvider(input: { organizationId: string; ownerMemberId: string }): Promise<AutomationAuthorityProvider | null>
  findProvider(input: { organizationId: string; providerId: string }): Promise<AutomationAuthorityProvider | null>
  findModel(input: { providerRecordId: ProviderId; modelId: string }): Promise<AutomationAuthorityModel | null>
  canAccessProvider(input: { member: AutomationAuthorityMember; providerRecordId: ProviderId }): Promise<boolean>
  allowsZenModel(input: { organizationId: string; ownerMemberId: string }): Promise<boolean>
}

const databaseAuthorityStore: AutomationModelAuthorityStore = {
  async findActiveMember(input) {
    const members = await db.select().from(MemberTable).where(and(
      eq(MemberTable.id, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(MemberTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
      isNull(MemberTable.removedAt),
    )).limit(1)
    return members[0] ?? null
  },

  async findOpenWorkProvider(input) {
    const providers = await db.select().from(LlmProviderTable).where(and(
      eq(LlmProviderTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
      eq(LlmProviderTable.createdByOrgMembershipId, normalizeDenTypeId("member", input.ownerMemberId)),
      eq(LlmProviderTable.source, "openwork"),
      eq(LlmProviderTable.providerId, "openwork"),
    )).limit(1)
    return providers[0] ?? null
  },

  async findProvider(input) {
    let providerId: ProviderId
    try {
      providerId = normalizeDenTypeId("llmProvider", input.providerId)
    } catch {
      return null
    }
    const providers = await db.select().from(LlmProviderTable).where(and(
      eq(LlmProviderTable.id, providerId),
      eq(LlmProviderTable.organizationId, normalizeDenTypeId("organization", input.organizationId)),
    )).limit(1)
    return providers[0] ?? null
  },

  async findModel(input) {
    const models = await db.select().from(LlmProviderModelTable).where(and(
      eq(LlmProviderModelTable.llmProviderId, normalizeDenTypeId("llmProvider", input.providerRecordId)),
      eq(LlmProviderModelTable.modelId, input.modelId),
    )).limit(1)
    return models[0] ?? null
  },

  async canAccessProvider(input) {
    const teamRows = await db.select({ id: TeamMemberTable.teamId }).from(TeamMemberTable)
      .where(eq(TeamMemberTable.orgMembershipId, input.member.id))
    const teamIds = teamRows.map((row) => row.id)
    const grants = await db.select({ id: LlmProviderAccessTable.id }).from(LlmProviderAccessTable).where(and(
      eq(LlmProviderAccessTable.llmProviderId, normalizeDenTypeId("llmProvider", input.providerRecordId)),
      or(
        eq(LlmProviderAccessTable.orgMembershipId, input.member.id),
        ...(teamIds.length > 0 ? [inArray(LlmProviderAccessTable.teamId, teamIds)] : []),
        and(isNull(LlmProviderAccessTable.orgMembershipId), isNull(LlmProviderAccessTable.teamId)),
      ),
    )).limit(1)
    return Boolean(grants[0])
  },

  async allowsZenModel(input) {
    const policy = await calculateDesktopPolicyForOrgMember({
      organizationId: normalizeDenTypeId("organization", input.organizationId),
      orgMemberId: normalizeDenTypeId("member", input.ownerMemberId),
    })
    return policy.allowZenModel
  },
}

function enabledOpenWorkModel(modelId: string) {
  const model = Object.entries(INFERENCE_MODEL_ALIASES)
    .find(([candidate]) => candidate === modelId)?.[1]
  return model?.enabled === true ? model : null
}

function resolvedProviderModel(input: {
  accessKind: ResolvedAutomationModel["accessKind"]
  providerId: string
  modelId: string
  provider: AutomationAuthorityProvider
  model: AutomationAuthorityModel
}): ResolvedAutomationModel {
  return {
    accessKind: input.accessKind,
    providerRecordId: input.provider.id,
    providerId: input.providerId,
    modelId: input.modelId,
    providerName: input.provider.name,
    modelName: input.model.name,
  }
}

export async function resolveAutomationModelAccessWithStore(
  input: { organizationId: string; ownerMemberId: string } & AutomationModelSelection,
  store: AutomationModelAuthorityStore,
): Promise<AutomationAuthorityResult> {
  const member = await store.findActiveMember(input)
  if (!member) {
    return { ok: false, code: "owner_membership_lost", message: "The Automation owner is no longer an active organization member." }
  }

  if (input.providerId === AUTOMATION_FREE_MODEL.providerId) {
    if (input.modelId !== AUTOMATION_FREE_MODEL.modelId) {
      return { ok: false, code: "model_access_lost", message: "The selected free model is not available for Automations." }
    }
    if (!await store.allowsZenModel(input)) {
      return {
        ok: false,
        code: "model_access_lost",
        message: "The selected OpenCode Zen model is no longer available. Choose a supported model to resume this Automation.",
      }
    }
    return {
      ok: true,
      value: {
        accessKind: "free",
        providerRecordId: null,
        providerId: input.providerId,
        modelId: input.modelId,
        providerName: AUTOMATION_FREE_MODEL.providerName,
        modelName: AUTOMATION_FREE_MODEL.modelName,
      },
    }
  }

  if (input.providerId === "openwork") {
    // Older clients persist reasoning variants. Model access must not change
    // merely because the catalog no longer offers one of those settings.
    // Validate execution parameters at the runtime boundary instead.
    const model = enabledOpenWorkModel(input.modelId)
    if (!model) {
      return { ok: false, code: "model_access_lost", message: "The selected OpenWork-managed model is not available." }
    }
    const provider = await store.findOpenWorkProvider(input)
    if (!provider) {
      return { ok: false, code: "provider_unavailable", message: "OpenWork Models are not available for the Automation owner." }
    }
    if (!await store.canAccessProvider({ member, providerRecordId: provider.id })) {
      return { ok: false, code: "model_access_lost", message: "The Automation owner no longer has access to OpenWork Models." }
    }
    return {
      ok: true,
      value: {
        accessKind: "openwork_managed",
        providerRecordId: provider.id,
        providerId: input.providerId,
        modelId: input.modelId,
        providerName: provider.name,
        modelName: model.displayName.replace(/^OpenWork:\s*/, ""),
      },
    }
  }

  const provider = await store.findProvider(input)
  if (!provider || provider.source === "openwork") {
    return { ok: false, code: "provider_unavailable", message: "The selected model provider is no longer available." }
  }
  const model = await store.findModel({ providerRecordId: provider.id, modelId: input.modelId })
  if (!model) {
    return { ok: false, code: "model_access_lost", message: "The selected model is no longer available from this provider." }
  }
  if (!await store.canAccessProvider({ member, providerRecordId: provider.id })) {
    return { ok: false, code: "model_access_lost", message: "The Automation owner no longer has access to the selected model." }
  }
  return { ok: true, value: resolvedProviderModel({ accessKind: "authorized_custom", providerId: input.providerId, modelId: input.modelId, provider, model }) }
}

export async function isActiveAutomationOwnerWithStore(
  input: { organizationId: string; ownerMemberId: string },
  store: AutomationModelAuthorityStore,
): Promise<boolean> {
  return Boolean(await store.findActiveMember(input))
}

/**
 * Runner tokens outlive membership changes (12h HMAC credentials with no
 * server-side state), so every runner request re-checks that the owner is
 * still an active member before honoring the token.
 */
export function isActiveAutomationOwner(
  input: { organizationId: string; ownerMemberId: string },
): Promise<boolean> {
  return isActiveAutomationOwnerWithStore(input, databaseAuthorityStore)
}

export function resolveAutomationModelAccess(input: {
  organizationId: string
  ownerMemberId: string
  providerId: string
  modelId: string
  variant?: string | null
}): Promise<AutomationAuthorityResult> {
  return resolveAutomationModelAccessWithStore(input, databaseAuthorityStore)
}

export async function requireAutomationModelAccess(input: Parameters<typeof resolveAutomationModelAccess>[0]): Promise<ResolvedAutomationModel> {
  const result = await resolveAutomationModelAccess(input)
  if (!result.ok) {
    const error = new Error(result.message)
    error.name = result.code
    throw error
  }
  return result.value
}
