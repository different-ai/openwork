/**
 * LiteLLM gateway provider requests and display helpers. Request bodies mirror
 * den-api's /v1/inference-providers/litellm schemas; keys are write-only and
 * never read back.
 */
import type { GatewayLiteLlmAttentionReason, GatewayLiteLlmStatus, GatewayLiteLlmSyncResult } from "@openwork/types/den/gateway";
import { auditOperationHeaders, type AuditOperationContext } from "@openwork/types/den/audit";
import { microsoftApiScopeError, microsoftTenantIdSchema } from "@openwork/types/den/inference";
import { z } from "zod";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { readInferenceProviderFromPayload, type DenInferenceProvider } from "./inference-provider-request";

export const LITELLM_PROVIDER_ID = "litellm";
export const LITELLM_DOC_URL = "https://docs.litellm.ai";
export const LITELLM_ENTRA_DOC_URL = "https://openworklabs.com/docs/ai-gateway/litellm#microsoft-sign-in";
/** Microsoft sign-in for LiteLLM is a rollout: without it the choice stays locked. */
export const LITELLM_ENTRA_FEATURE = "litellmEntraMemberSignIn";

/**
 * What the admin chooses: one shared key, each person pastes theirs, OpenWork
 * creates them, or (entra) the proxy takes sign-in tokens and each person signs
 * in with Microsoft.
 */
export type LiteLlmMode = "org" | "member" | "issued" | "entra";
export type LiteLlmIssueStrategy = "per_team" | "mirror";
export type LiteLlmMirrorFallback = "per_team" | "error";

/** Microsoft sign-in: the organization's Entra app registration, one API scope and the models people may use. */
export type LiteLlmEntraInput = { tenantId: string; clientId: string; clientSecret: string; scope: string; models: string };
export const EMPTY_LITELLM_ENTRA: LiteLlmEntraInput = { tenantId: "", clientId: "", clientSecret: "", scope: "", models: "" };

export type LiteLlmCreateInput = {
  name: string;
  baseUrl: string;
  mode: LiteLlmMode;
  apiKey: string;
  access: { allMembers: boolean; memberIds: string[]; teamIds: string[] };
  issueStrategy?: LiteLlmIssueStrategy;
  mirrorFallback?: LiteLlmMirrorFallback;
  entra?: LiteLlmEntraInput;
};

/** The admin-facing mode of a saved provider. */
export function liteLlmStatusMode(status: Pick<GatewayLiteLlmStatus, "mode" | "keySource">): LiteLlmMode {
  return status.mode === "org" ? "org" : status.keySource === "issued" ? "issued" : status.keySource === "entra" ? "entra" : "member";
}

/** Model names from a list typed one per line (commas work too), without blanks or repeats. */
export function parseLiteLlmModelList(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean))];
}

export function buildLiteLlmCreateBody(input: LiteLlmCreateInput) {
  const access = {
    ...(input.access.allMembers ? { allMembers: true } : {}),
    ...(input.access.memberIds.length ? { memberIds: [...new Set(input.access.memberIds)] } : {}),
    ...(input.access.teamIds.length ? { teamIds: [...new Set(input.access.teamIds)] } : {}),
  };
  if (input.mode === "entra") {
    const entra = input.entra ?? EMPTY_LITELLM_ENTRA;
    return {
      name: input.name.trim() || "LiteLLM",
      baseUrl: input.baseUrl.trim(),
      mode: input.mode,
      oauthTenantId: entra.tenantId.trim().toLowerCase(),
      oauthClientId: entra.clientId.trim(),
      oauthClientSecret: entra.clientSecret.trim(),
      oauthScope: entra.scope.trim(),
      modelIds: parseLiteLlmModelList(entra.models),
      ...access,
    };
  }
  return {
    name: input.name.trim() || "LiteLLM",
    baseUrl: input.baseUrl.trim(),
    mode: input.mode,
    ...(input.mode === "issued" ? { issueStrategy: input.issueStrategy ?? "per_team", mirrorFallback: input.mirrorFallback ?? "per_team" } : {}),
    apiKey: input.apiKey.trim(),
    ...access,
  };
}

/**
 * What is wrong with Microsoft sign-in settings, or null. `saved` is a provider
 * being edited: its client secret is kept unless a new one is typed.
 */
export function liteLlmEntraError(entra: LiteLlmEntraInput, saved = false): string | null {
  if (!microsoftTenantIdSchema.safeParse(entra.tenantId.trim()).success) return "Enter the Entra directory (tenant) ID, for example 00000000-0000-0000-0000-000000000000.";
  if (!entra.clientId.trim()) return "Enter the application (client) ID of your Entra app registration.";
  if (!saved && !entra.clientSecret.trim()) return "Paste a client secret of your Entra app registration.";
  const scopeError = microsoftApiScopeError(entra.scope);
  if (scopeError) return scopeError;
  const models = parseLiteLlmModelList(entra.models);
  if (!models.length) return "Enter at least one LiteLLM model name, one per line.";
  if (models.some((model) => model.includes("*"))) return "Enter model names, not wildcards such as openai/*.";
  if (models.length > 500) return "Enter at most 500 models.";
  return null;
}

/** Client-side check before the server verifies the key against the proxy. */
export function liteLlmCreateError(input: LiteLlmCreateInput): string | null {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return "Enter your LiteLLM proxy URL.";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The LiteLLM URL must start with https://.";
  } catch { return "Enter a full URL, for example https://litellm.example.com."; }
  if (input.mode === "entra") return liteLlmEntraError(input.entra ?? EMPTY_LITELLM_ENTRA);
  if (!input.apiKey.trim()) return input.mode === "org" ? "Paste the LiteLLM key everyone will share."
    : input.mode === "issued" ? "Paste a LiteLLM admin key so OpenWork can create each person's key."
      : "Paste a LiteLLM admin key so OpenWork can read your models and teams.";
  return null;
}

export function liteLlmKeyLabel(mode: LiteLlmMode) {
  return mode === "org" ? "Organization key" : "Admin key";
}

export function liteLlmModeLabel(mode: LiteLlmMode) {
  return mode === "org" ? "One organization key" : mode === "issued" ? "OpenWork creates keys" : mode === "entra" ? "Microsoft sign-in" : "Each person's own key";
}

/** Keep a blocked sign-in choice discoverable while leaving the three key modes usable. */
export function liteLlmModeOptions(entraAvailable: boolean): Array<{ value: LiteLlmMode; label: string; disabled: boolean }> {
  const modes: LiteLlmMode[] = ["org", "member", "issued", "entra"];
  return modes.map((value) => ({ value, label: liteLlmModeLabel(value), disabled: value === "entra" && !entraAvailable }));
}

export function liteLlmIssueStrategyLabel(strategy: LiteLlmIssueStrategy) {
  return strategy === "mirror" ? "Copy their existing key" : "One per LiteLLM team";
}

export function liteLlmMirrorFallbackLabel(fallback: LiteLlmMirrorFallback) {
  return fallback === "error" ? "Show an error" : "Use their teams";
}

export function liteLlmAttentionLabel(reason: GatewayLiteLlmAttentionReason) {
  return reason === "not_in_litellm" ? "Not in LiteLLM"
    : reason === "no_key_to_mirror" ? "No key to copy"
      : reason === "no_models" ? "No models allowed"
        : "Could not create key";
}

export function liteLlmSpendLabel(status: Pick<GatewayLiteLlmStatus, "spendTracking"> & { keySource?: GatewayLiteLlmStatus["keySource"] }) {
  return status.spendTracking ? "Tracked, priced from LiteLLM" : status.keySource === "entra" ? "Not tracked, LiteLLM budgets each person" : "Not tracked, LiteLLM budgets each key";
}

export function liteLlmAccessTitle(mode: LiteLlmMode) {
  return mode === "org" ? "Who can use it" : mode === "issued" ? "Who gets a key" : mode === "entra" ? "Who can sign in" : "Who can connect a key";
}

export function liteLlmAccessGroupId(provider: Pick<DenInferenceProvider, "litellm" | "modelGroups">): string | null {
  const mode = provider.litellm ? liteLlmStatusMode(provider.litellm) : "org";
  // Microsoft sign-in grants the group that holds the admin's model list, as one organization key does.
  const name = mode === "issued" ? "Gets a LiteLLM key" : mode === "member" ? "Can connect a LiteLLM key" : "All LiteLLM models";
  return provider.modelGroups?.find((group) => group.name === name)?.id ?? provider.modelGroups?.[0]?.id ?? null;
}

/** "Synced 5 min ago", or "Never synced". */
export function liteLlmSyncedLabel(lastSyncedAt: string | null, now = Date.now()) {
  if (!lastSyncedAt) return "Never synced";
  const at = new Date(lastSyncedAt).getTime();
  if (!Number.isFinite(at)) return "Never synced";
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours} h ago`;
  return `Synced ${new Date(at).toLocaleDateString()}`;
}

const syncResultSchema: z.ZodType<GatewayLiteLlmSyncResult> = z.object({
  modelCount: z.number(), groupCount: z.number(), teamCount: z.number(),
  members: z.object({ matched: z.number(), rejected: z.number(), unavailable: z.number(), removed: z.number() }),
  warnings: z.array(z.string()),
  issued: z.object({ people: z.number(), keys: z.number(), notInLiteLlm: z.number(), noKeyToMirror: z.number(), noModels: z.number(), errors: z.number(), removed: z.number() }).optional(),
});

function readResult(payload: unknown) {
  const provider = readInferenceProviderFromPayload(payload);
  const sync = z.object({ sync: syncResultSchema }).safeParse(payload);
  if (!provider || !sync.success) throw new Error("The server returned an unexpected LiteLLM response.");
  return { provider, sync: sync.data.sync };
}

export async function createLiteLlmProvider(input: LiteLlmCreateInput, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson("/v1/inference-providers/litellm", {
    method: "POST", body: JSON.stringify(buildLiteLlmCreateBody(input)), headers: auditOperationHeaders(auditContext),
  }, 30000);
  if (!response.ok) throw getRequestError(payload, response, `Could not connect LiteLLM (${response.status}).`);
  return readResult(payload);
}

export async function syncLiteLlmProvider(providerId: string, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(providerId)}/litellm/sync`, {
    method: "POST", headers: auditOperationHeaders(auditContext),
  }, 60000);
  if (!response.ok) throw getRequestError(payload, response, `Could not sync LiteLLM (${response.status}).`);
  return readResult(payload);
}

export async function replaceLiteLlmKey(providerId: string, apiKey: string, auditContext?: AuditOperationContext) {
  return updateLiteLlm(providerId, { apiKey: apiKey.trim() }, auditContext);
}

export async function updateLiteLlmIssue(providerId: string, input: { issueStrategy?: LiteLlmIssueStrategy; mirrorFallback?: LiteLlmMirrorFallback }, auditContext?: AuditOperationContext) {
  return updateLiteLlm(providerId, input, auditContext);
}

/**
 * What changed in a saved provider's Microsoft sign-in settings and model list,
 * as the PATCH body. An untouched client secret is left out, so it is kept.
 * Null when nothing changed.
 */
export function buildLiteLlmEntraUpdateBody(saved: LiteLlmEntraInput, next: LiteLlmEntraInput): Record<string, string | string[]> | null {
  const body: Record<string, string | string[]> = {};
  if (next.tenantId.trim().toLowerCase() !== saved.tenantId.trim().toLowerCase()) body.oauthTenantId = next.tenantId.trim().toLowerCase();
  if (next.clientId.trim() !== saved.clientId.trim()) body.oauthClientId = next.clientId.trim();
  if (next.clientSecret.trim()) body.oauthClientSecret = next.clientSecret.trim();
  if (next.scope.trim() !== saved.scope.trim()) body.oauthScope = next.scope.trim();
  const models = parseLiteLlmModelList(next.models);
  if (JSON.stringify(models) !== JSON.stringify(parseLiteLlmModelList(saved.models))) body.modelIds = models;
  return Object.keys(body).length ? body : null;
}

/** A change to the tenant, app registration, client secret or scope signs everyone out; a model list change does not. */
export function liteLlmEntraUpdateSignsPeopleOut(body: Record<string, string | string[]>): boolean {
  return ["oauthTenantId", "oauthClientId", "oauthClientSecret", "oauthScope"].some((key) => key in body);
}

export async function updateLiteLlmEntra(providerId: string, body: Record<string, string | string[]>, auditContext?: AuditOperationContext) {
  return updateLiteLlm(providerId, body, auditContext, "Could not save the Microsoft sign-in settings");
}

async function updateLiteLlm(providerId: string, body: Record<string, string | string[]>, auditContext?: AuditOperationContext, failure = "Could not replace the LiteLLM key") {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(providerId)}/litellm`, {
    method: "PATCH", body: JSON.stringify(body), headers: auditOperationHeaders(auditContext),
  }, 120000);
  if (!response.ok) throw getRequestError(payload, response, `${failure} (${response.status}).`);
  return readResult(payload);
}

export function liteLlmSyncSummary(sync: GatewayLiteLlmSyncResult) {
  const parts = [`${sync.modelCount} ${sync.modelCount === 1 ? "model" : "models"}`];
  if (sync.issued) {
    parts.push(`keys for ${sync.issued.people} ${sync.issued.people === 1 ? "person" : "people"}`);
    const missing = sync.issued.notInLiteLlm + sync.issued.noKeyToMirror + sync.issued.noModels + sync.issued.errors;
    if (missing) parts.push(`${missing} need attention`);
    if (sync.issued.removed) parts.push(`${sync.issued.removed} removed`);
  }
  if (sync.members.rejected) parts.push(`${sync.members.rejected} ${sync.members.rejected === 1 ? "key" : "keys"} rejected by LiteLLM`);
  if (sync.members.removed) parts.push(`${sync.members.removed} ${sync.members.removed === 1 ? "person" : "people"} lost access`);
  return `Synced ${parts.join(", ")}.`;
}
