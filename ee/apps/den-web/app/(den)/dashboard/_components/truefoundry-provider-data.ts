/**
 * TrueFoundry gateway provider requests and display helpers. Request bodies
 * mirror den-api's /v1/inference-providers/truefoundry schemas; the admin key
 * is write-only and never read back, and people's tokens never leave Den.
 */
import type { GatewayTrueFoundryAttentionReason, GatewayTrueFoundryStatus, GatewayTrueFoundrySyncResult } from "@openwork/types/den/gateway";
import { auditOperationHeaders, type AuditOperationContext } from "@openwork/types/den/audit";
import { z } from "zod";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { readInferenceProviderFromPayload, type DenInferenceProvider } from "./inference-provider-request";

export { TRUEFOUNDRY_PROVIDER_ID } from "@openwork-ee/gateway-catalog";
export const TRUEFOUNDRY_DOC_URL = "https://www.truefoundry.com";
export const TRUEFOUNDRY_ACCESS_GROUP_NAME = "Gets a TrueFoundry key";
export const TRUEFOUNDRY_TOO_MANY_TOKENS_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/truefoundry-too-many-tokens";

export const CREATE_MISSING_USERS_LABEL = "Create missing users in TrueFoundry";
// Spec wording, with "Virtual Account" replaced: the key OpenWork creates is a personal access token owned by the new user.
export const CREATE_MISSING_USERS_DESCRIPTION = "If a user exists in OpenWork but not in TrueFoundry, create a new user in TrueFoundry and generate a new API key for them. Only default models will be available to the user until you configure their teams and access in TrueFoundry.";

export const TRACK_USAGE_COSTS_LABEL = "Track usage costs in OpenWork";
export const TRACK_USAGE_COSTS_DESCRIPTION = "Where possible, track the cost of user's usages inside OpenWork contributing to users configured limits and usage tracking. This will use the models default public pricing";

/** The status row: what OpenWork does with spend for this provider. */
export function trueFoundrySpendLabel(trackUsageCosts: boolean) {
  return trackUsageCosts ? "Tracked in OpenWork at public pricing, where a model has it" : "Not tracked, TrueFoundry budgets each person";
}

export type TrueFoundryCreateInput = {
  name: string;
  controlPlaneUrl: string;
  apiKey: string;
  createMissingUsers: boolean;
  trackUsageCosts: boolean;
  access: { allMembers: boolean; memberIds: string[]; teamIds: string[] };
};

export function buildTrueFoundryCreateBody(input: TrueFoundryCreateInput) {
  return {
    name: input.name.trim() || "TrueFoundry",
    controlPlaneUrl: input.controlPlaneUrl.trim(),
    apiKey: input.apiKey.trim(),
    createMissingUsers: input.createMissingUsers,
    trackUsageCosts: input.trackUsageCosts,
    ...(input.access.allMembers ? { allMembers: true } : {}),
    ...(input.access.memberIds.length ? { memberIds: [...new Set(input.access.memberIds)] } : {}),
    ...(input.access.teamIds.length ? { teamIds: [...new Set(input.access.teamIds)] } : {}),
  };
}

/** Client-side check before the server verifies the key with TrueFoundry. */
export function trueFoundryCreateError(input: Pick<TrueFoundryCreateInput, "controlPlaneUrl" | "apiKey">): string | null {
  const address = input.controlPlaneUrl.trim();
  if (!address) return "Enter the address you open TrueFoundry at.";
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The TrueFoundry address must start with https://.";
  } catch { return "Enter a full address, for example https://acme.truefoundry.cloud."; }
  const key = input.apiKey.trim();
  if (!key) return "Paste a TrueFoundry virtual account token with the tenant admin role.";
  if (key.startsWith("tfy_pat_")) return "This is a personal access token. Paste a virtual account token with the tenant admin role instead.";
  return null;
}

export function trueFoundryAttentionLabel(reason: GatewayTrueFoundryAttentionReason) {
  return reason === "not_in_truefoundry" ? "Not in TrueFoundry"
    : reason === "user_inactive" ? "Deactivated in TrueFoundry"
      : reason === "token_limit" ? "Too many tokens"
        : reason === "no_models" ? "No models yet"
          : "Could not create key";
}

export function trueFoundryAccessGroupId(provider: Pick<DenInferenceProvider, "modelGroups">): string | null {
  return provider.modelGroups?.find((group) => group.name === TRUEFOUNDRY_ACCESS_GROUP_NAME)?.id ?? null;
}

const syncResultSchema: z.ZodType<GatewayTrueFoundrySyncResult> = z.object({
  modelCount: z.number(), people: z.number(), tokensCreated: z.number(), usersCreated: z.number(),
  notInTrueFoundry: z.number(), noModels: z.number(), tokenLimit: z.number(), errors: z.number(), removed: z.number(),
});

function readResult(payload: unknown) {
  const provider = readInferenceProviderFromPayload(payload);
  const sync = z.object({ sync: syncResultSchema }).safeParse(payload);
  if (!provider || !sync.success) throw new Error("The server returned an unexpected TrueFoundry response.");
  return { provider, sync: sync.data.sync };
}

export async function createTrueFoundryProvider(input: TrueFoundryCreateInput, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson("/v1/inference-providers/truefoundry", {
    method: "POST", body: JSON.stringify(buildTrueFoundryCreateBody(input)), headers: auditOperationHeaders(auditContext),
  }, 120000);
  if (!response.ok) throw getRequestError(payload, response, `Could not connect TrueFoundry (${response.status}).`);
  return readResult(payload);
}

export async function syncTrueFoundryProvider(providerId: string, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(providerId)}/truefoundry/sync`, {
    method: "POST", headers: auditOperationHeaders(auditContext),
  }, 120000);
  if (!response.ok) throw getRequestError(payload, response, `Could not sync TrueFoundry (${response.status}).`);
  return readResult(payload);
}

export async function updateTrueFoundryProvider(providerId: string, body: { apiKey?: string; createMissingUsers?: boolean; trackUsageCosts?: boolean; modelIds?: string[] | null }, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(providerId)}/truefoundry`, {
    method: "PATCH", body: JSON.stringify(body.apiKey === undefined ? body : { ...body, apiKey: body.apiKey.trim() }), headers: auditOperationHeaders(auditContext),
  }, 120000);
  if (!response.ok) throw getRequestError(payload, response, `Could not update TrueFoundry (${response.status}).`);
  return readResult(payload);
}

/**
 * Revokes every TrueFoundry token a person at the token limit holds, then creates a new OpenWork key.
 * Returns their new state, e.g. "active", or "token_limit" if TrueFoundry still refuses.
 */
export async function resetTrueFoundryMemberTokens(providerId: string, memberId: string, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(providerId)}/truefoundry/members/${encodeURIComponent(memberId)}/reset-tokens`, {
    method: "POST", headers: auditOperationHeaders(auditContext),
  }, 120000);
  if (!response.ok) throw getRequestError(payload, response, `Could not reset their TrueFoundry tokens (${response.status}).`);
  const parsed = z.object({ status: z.string(), message: z.string().nullable(), ready: z.boolean() }).safeParse(payload);
  if (!parsed.success) throw new Error("The server returned an unexpected TrueFoundry response.");
  return parsed.data;
}

export function trueFoundrySyncSummary(sync: GatewayTrueFoundrySyncResult) {
  const parts = [`${sync.modelCount} ${sync.modelCount === 1 ? "model" : "models"}`, `keys for ${sync.people} ${sync.people === 1 ? "person" : "people"}`];
  if (sync.usersCreated) parts.push(`${sync.usersCreated} added to TrueFoundry`);
  const attention = sync.notInTrueFoundry + sync.noModels + sync.tokenLimit + sync.errors;
  if (attention) parts.push(`${attention} need attention`);
  if (sync.removed) parts.push(`${sync.removed} removed`);
  return `Synced ${parts.join(", ")}.`;
}

/** `openai-main/gpt-5.5` -> `openai-main`: the TrueFoundry provider account a model is served through. */
export function trueFoundryModelAccount(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(0, slash) : "TrueFoundry";
}

/** Picked models that TrueFoundry still lists, in the order it lists them. */
export function trueFoundryPickedModels(status: Pick<GatewayTrueFoundryStatus, "availableModels" | "selectedModelIds">): string[] {
  const picked = new Set(status.selectedModelIds ?? status.availableModels.map((model) => model.id));
  return status.availableModels.filter((model) => picked.has(model.id)).map((model) => model.id);
}

/** Whether the admin's draft differs from what is saved. Order does not matter. */
export function trueFoundryModelPickChanged(status: Pick<GatewayTrueFoundryStatus, "availableModels" | "selectedModelIds">, draft: { allowAll: boolean; modelIds: string[] }): boolean {
  if (draft.allowAll !== (status.selectedModelIds === null)) return true;
  if (draft.allowAll) return false;
  const saved = new Set(trueFoundryPickedModels(status));
  const next = new Set(draft.modelIds);
  return saved.size !== next.size || [...next].some((id) => !saved.has(id));
}

export function trueFoundryStatusSummary(status: Pick<GatewayTrueFoundryStatus, "activeMemberCount" | "modelCount">) {
  return `${status.modelCount} ${status.modelCount === 1 ? "model" : "models"} · ${status.activeMemberCount} ${status.activeMemberCount === 1 ? "person" : "people"} with keys`;
}
