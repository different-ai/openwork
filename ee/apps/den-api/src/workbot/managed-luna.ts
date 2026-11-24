import { freeModelsNeedDesktop } from "../features.js"
import { assertFundedUserAllowed } from "../openai-safety/account-suspensions.js"
import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { InferenceOrgUpstreamProviderKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { freeInferenceOrganizationAllowed, INFERENCE_FREE_MODEL_ID, INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import { isWorkbotManagedLuna, WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID } from "@openwork/types/den/workbot-settings"
import type { HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import { db } from "../db.js"
import { env } from "../env.js"
import { ensureMemberInferenceKey, getMemberInferenceAccess, issueMemberFreeInferenceCredential, organizationAllowsManagedModels, readInferenceMetadata } from "../inference.js"
import { CloudAgentGatewayAccessError, type CloudAgentGatewayActor } from "./gateway-model.js"

export function workbotUsesManagedDefault(chosen: string | null): boolean {
  return chosen === null || isWorkbotManagedLuna(chosen)
}

type ManagedLunaState = Awaited<ReturnType<typeof workbotManagedLunaState>>

export function workbotManagedLunaRoutable(state: ManagedLunaState): boolean {
  return state.paid ? state.allowed : state.allowed && ["free", "exhausted"].includes(state.free.kind)
}

export async function workbotIncludedDefaultModel(actor: CloudAgentGatewayActor, chosen: string | null): Promise<string | null> {
  if (chosen === WORKBOT_PAID_LUNA_ID) return chosen
  const state = await workbotManagedLunaState(actor).catch(() => null)
  if (!state) return WORKBOT_FREE_LUNA_ID
  return workbotManagedLunaRoutable(state) ? state.model : null
}

export async function workbotOrganizationManagedDefaultRoutable(organizationId: string, chosen: string | null): Promise<boolean> {
  if (!workbotUsesManagedDefault(chosen)) return false
  if (chosen === WORKBOT_PAID_LUNA_ID) return true
  const orgId = normalizeDenTypeId("organization", organizationId)
  if (!await organizationAllowsManagedModels(orgId)) return false
  const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, orgId)).limit(1)
  if (!organization) return false
  if (readInferenceMetadata(organization.metadata)) return true
  if (await freeModelsNeedDesktop(orgId)) return false
  return env.inferenceFree.enabled && freeInferenceOrganizationAllowed(organization.metadata)
}

export async function workbotManagedLunaState(actor: CloudAgentGatewayActor) {
  const organizationId = normalizeDenTypeId("organization", actor.organizationId)
  const userId = normalizeDenTypeId("user", actor.userId)
  const [member] = await db.select({ id: MemberTable.id, metadata: OrganizationTable.metadata }).from(MemberTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt))).limit(1)
  if (!member) throw new CloudAgentGatewayAccessError("model_access_unavailable")
  const paid = Boolean(readInferenceMetadata(member.metadata))
  const allowed = await organizationAllowsManagedModels(organizationId) && (paid || !await freeModelsNeedDesktop(organizationId))
  const [upstream] = paid ? await db.select({ id: InferenceOrgUpstreamProviderKeyTable.id }).from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId), eq(InferenceOrgUpstreamProviderKeyTable.provider, "openrouter"), eq(InferenceOrgUpstreamProviderKeyTable.status, "active"))).limit(1) : []
  const paidReady = allowed && paid && Boolean(upstream) && INFERENCE_MODEL_ALIASES[INFERENCE_FREE_MODEL_ID].enabled
  const input = { organizationId, memberId: member.id, userId }
  const free = await getMemberInferenceAccess(input)
  return { input, allowed, paid, paidReady, free, model: paid ? WORKBOT_PAID_LUNA_ID : WORKBOT_FREE_LUNA_ID }
}

export async function workbotManagedLunaAccess(actor: CloudAgentGatewayActor, model: string): Promise<HeadlessModelAccess> {
  await assertFundedUserAllowed(actor.userId)
  const state = await workbotManagedLunaState(actor)
  if (model === WORKBOT_PAID_LUNA_ID) {
    if (!state.paidReady) throw new CloudAgentGatewayAccessError("managed_models_setup_required")
    const apiKey = await ensureMemberInferenceKey(state.input)
    return { baseUrl: `${env.modelsPublicBaseUrl.replace(/\/+$/, "")}/api/v1`, apiKey, protocol: "openai", model: INFERENCE_FREE_MODEL_ID }
  }
  if (model !== WORKBOT_FREE_LUNA_ID || !state.allowed || await freeModelsNeedDesktop(state.input.organizationId) || !["free", "exhausted"].includes(state.free.kind)) throw new CloudAgentGatewayAccessError("model_access_unavailable")
  const issued = await issueMemberFreeInferenceCredential(state.input)
  if (!("credential" in issued)) throw new CloudAgentGatewayAccessError("model_access_unavailable")
  return { baseUrl: issued.credential.baseURL, apiKey: issued.credential.apiKey, protocol: "openai-responses", model: INFERENCE_FREE_MODEL_ID }
}
