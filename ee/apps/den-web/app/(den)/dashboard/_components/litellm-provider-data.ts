/**
 * LiteLLM gateway provider requests and display helpers. Request bodies mirror
 * den-api's /v1/inference-providers/litellm schemas; keys are write-only and
 * never read back.
 */
import type { GatewayLiteLlmAttentionReason, GatewayLiteLlmStatus, GatewayLiteLlmSyncResult } from "@openwork/types/den/gateway";
import { auditOperationHeaders, type AuditOperationContext } from "@openwork/types/den/audit";
import { z } from "zod";
import { getRequestError, requestJson } from "../../_lib/den-flow";
import { readInferenceProviderFromPayload, type DenInferenceProvider } from "./inference-provider-request";

export const LITELLM_PROVIDER_ID = "litellm";
export const LITELLM_DOC_URL = "https://docs.litellm.ai";

/** What the admin chooses: one shared key, each person pastes theirs, or OpenWork creates them. */
export type LiteLlmMode = "org" | "member" | "issued";
export type LiteLlmIssueStrategy = "per_team" | "mirror";
export type LiteLlmMirrorFallback = "per_team" | "error";

export type LiteLlmCreateInput = {
  name: string;
  baseUrl: string;
  mode: LiteLlmMode;
  apiKey: string;
  access: { allMembers: boolean; memberIds: string[]; teamIds: string[] };
  issueStrategy?: LiteLlmIssueStrategy;
  mirrorFallback?: LiteLlmMirrorFallback;
};

/** The admin-facing mode of a saved provider. */
export function liteLlmStatusMode(status: Pick<GatewayLiteLlmStatus, "mode" | "keySource">): LiteLlmMode {
  return status.mode === "org" ? "org" : status.keySource === "issued" ? "issued" : "member";
}

export function buildLiteLlmCreateBody(input: LiteLlmCreateInput) {
  return {
    name: input.name.trim() || "LiteLLM",
    baseUrl: input.baseUrl.trim(),
    mode: input.mode,
    ...(input.mode === "issued" ? { issueStrategy: input.issueStrategy ?? "per_team", mirrorFallback: input.mirrorFallback ?? "per_team" } : {}),
    apiKey: input.apiKey.trim(),
    ...(input.access.allMembers ? { allMembers: true } : {}),
    ...(input.access.memberIds.length ? { memberIds: [...new Set(input.access.memberIds)] } : {}),
    ...(input.access.teamIds.length ? { teamIds: [...new Set(input.access.teamIds)] } : {}),
  };
}

/** Client-side check before the server verifies the key against the proxy. */
export function liteLlmCreateError(input: LiteLlmCreateInput): string | null {
  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return "Enter your LiteLLM proxy URL.";
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "The LiteLLM URL must start with https://.";
  } catch { return "Enter a full URL, for example https://litellm.example.com."; }
  if (!input.apiKey.trim()) return input.mode === "org" ? "Paste the LiteLLM key everyone will share."
    : input.mode === "issued" ? "Paste a LiteLLM admin key so OpenWork can create each person's key."
      : "Paste a LiteLLM admin key so OpenWork can read your models and teams.";
  return null;
}

export function liteLlmKeyLabel(mode: LiteLlmMode) {
  return mode === "org" ? "Organization key" : "Admin key";
}

export function liteLlmModeLabel(mode: LiteLlmMode) {
  return mode === "org" ? "One organization key" : mode === "issued" ? "OpenWork creates keys" : "Each person's own key";
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

export function liteLlmSpendLabel(status: Pick<GatewayLiteLlmStatus, "spendTracking">) {
  return status.spendTracking ? "Tracked, priced from LiteLLM" : "Not tracked, LiteLLM budgets each key";
}

export function liteLlmAccessTitle(mode: LiteLlmMode) {
  return mode === "org" ? "Who can use it" : mode === "issued" ? "Who gets a key" : "Who can connect a key";
}

export function liteLlmAccessGroupId(provider: Pick<DenInferenceProvider, "litellm" | "modelGroups">): string | null {
  const mode = provider.litellm ? liteLlmStatusMode(provider.litellm) : "org";
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

async function updateLiteLlm(providerId: string, body: Record<string, string>, auditContext?: AuditOperationContext) {
  const { response, payload } = await requestJson(`/v1/inference-providers/${encodeURIComponent(providerId)}/litellm`, {
    method: "PATCH", body: JSON.stringify(body), headers: auditOperationHeaders(auditContext),
  }, 120000);
  if (!response.ok) throw getRequestError(payload, response, `Could not replace the LiteLLM key (${response.status}).`);
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
