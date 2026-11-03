import { and, eq, isNotNull, isNull } from "@openwork-ee/den-db/drizzle"
import { InferenceOrgUpstreamProviderKeyTable, MemberTable, OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { INFERENCE_FREE_MODEL_ID, INFERENCE_MODEL_ALIASES } from "@openwork/types/den/inference"
import { isWorkbotManagedLuna, WORKBOT_FREE_LUNA_ID, WORKBOT_PAID_LUNA_ID } from "@openwork/types/den/workbot-settings"
import type { HeadlessModelAccess } from "@openwork-ee/headless-protocol"
import { db } from "../db.js"
import { env } from "../env.js"
import { ensureMemberInferenceKey, getMemberInferenceAccess, issueMemberFreeInferenceCredential, organizationAllowsManagedModels, readInferenceMetadata } from "../inference.js"
import { CloudAgentGatewayAccessError, type CloudAgentGatewayActor } from "./gateway-model.js"

/** The managed starter is the default only while no custom model is saved; a saved custom model is never migrated. */
export function workbotUsesManagedDefault(chosen: string | null): boolean {
  return chosen === null || isWorkbotManagedLuna(chosen)
}

type ManagedLunaState = Awaited<ReturnType<typeof workbotManagedLunaState>>

/**
 * Whether this member's included models can start a turn, or would report their own limit or setup state.
 * Paid members keep the paid route so a setup gap says so; free members with no free entitlement (policy or a
 * disabled allowance) are not routed there, so Workbot uses the workspace's Gateway instead.
 */
export function workbotManagedLunaRoutable(state: ManagedLunaState): boolean {
  return state.paid ? state.allowed : state.allowed && ["free", "exhausted"].includes(state.free.kind)
}

/**
 * Workbot's model for a new turn when the caller did not pin one: the member's included model when routable,
 * otherwise null so the turn uses the workspace's AI Gateway default. A failed entitlement read keeps the managed
 * selection; the turn then reauthorizes it and reports its own state instead of a misleading Gateway refusal.
 */
export async function workbotIncludedDefaultModel(actor: CloudAgentGatewayActor, chosen: string | null): Promise<string | null> {
  if (chosen === WORKBOT_PAID_LUNA_ID) return chosen
  const state = await workbotManagedLunaState(actor).catch(() => null)
  if (!state) return WORKBOT_FREE_LUNA_ID
  return workbotManagedLunaRoutable(state) ? state.model : null
}

/** Same member entitlement as desktop Models. No Gateway provider/grant or saved-default mutations. */
export async function workbotManagedLunaState(actor: CloudAgentGatewayActor) {
  const organizationId = normalizeDenTypeId("organization", actor.organizationId)
  const userId = normalizeDenTypeId("user", actor.userId)
  const [member] = await db.select({ id: MemberTable.id, metadata: OrganizationTable.metadata }).from(MemberTable)
    .innerJoin(OrganizationTable, eq(OrganizationTable.id, MemberTable.organizationId))
    .where(and(eq(MemberTable.organizationId, organizationId), eq(MemberTable.userId, userId), isNull(MemberTable.removedAt), isNotNull(MemberTable.joinedAt))).limit(1)
  if (!member) throw new CloudAgentGatewayAccessError("model_access_unavailable")
  const allowed = await organizationAllowsManagedModels(organizationId)
  const paid = Boolean(readInferenceMetadata(member.metadata))
  const [upstream] = paid ? await db.select({ id: InferenceOrgUpstreamProviderKeyTable.id }).from(InferenceOrgUpstreamProviderKeyTable)
    .where(and(eq(InferenceOrgUpstreamProviderKeyTable.organization_id, organizationId), eq(InferenceOrgUpstreamProviderKeyTable.provider, "openrouter"), eq(InferenceOrgUpstreamProviderKeyTable.status, "active"))).limit(1) : []
  const paidReady = allowed && paid && Boolean(upstream) && INFERENCE_MODEL_ALIASES[INFERENCE_FREE_MODEL_ID].enabled
  const input = { organizationId, memberId: member.id, userId }
  const free = await getMemberInferenceAccess(input)
  return { input, allowed, paid, paidReady, free, model: paid ? WORKBOT_PAID_LUNA_ID : WORKBOT_FREE_LUNA_ID }
}

/** Always reauthorize the exact saved selection. A subscription never turns a free retry into paid work. */
export async function workbotManagedLunaAccess(actor: CloudAgentGatewayActor, model: string): Promise<HeadlessModelAccess> {
  const state = await workbotManagedLunaState(actor)
  if (model === WORKBOT_PAID_LUNA_ID) {
    if (!state.paidReady) throw new CloudAgentGatewayAccessError("managed_models_setup_required")
    const apiKey = await ensureMemberInferenceKey(state.input)
    return { baseUrl: `${env.modelsPublicBaseUrl.replace(/\/+$/, "")}/api/v1`, apiKey, protocol: "openai", model: INFERENCE_FREE_MODEL_ID }
  }
  if (model !== WORKBOT_FREE_LUNA_ID || !state.allowed || !["free", "exhausted"].includes(state.free.kind)) throw new CloudAgentGatewayAccessError("model_access_unavailable")
  const issued = await issueMemberFreeInferenceCredential(state.input)
  if (!("credential" in issued)) throw new CloudAgentGatewayAccessError("model_access_unavailable")
  // Responses explicitly stays on Auto's free allowance, including in subscribed organizations.
  return { baseUrl: issued.credential.baseURL, apiKey: issued.credential.apiKey, protocol: "openai-responses", model: INFERENCE_FREE_MODEL_ID }
}
