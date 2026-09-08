import { INFERENCE_ACCESS_REASONS, type InferenceAccess, type ManagedModelRecommendation } from "@openwork/types/den/inference";
import { z } from "zod";
import type { ModelOption, ModelRef } from "../types";

export const FREE_LUNA_MODEL: ModelRef = { providerID: "openwork", modelID: "openai/gpt-5.6-luna" };
export const inferenceAccessRefreshEvent = "openwork.inference-access-refresh";
export const explicitModelChoiceKey = "openwork.modelChoice.explicit";

const usd = z.number().finite().nonnegative().nullable();
const managedModelRecommendationSchema: z.ZodType<ManagedModelRecommendation> = z.object({
  modelID: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  providerName: z.string().trim().min(1),
  summary: z.string().trim(),
  recommended: z.boolean(),
  rank: z.number().finite(),
  capabilities: z.array(z.string().trim().min(1)),
});
export const inferenceAccessSchema: z.ZodType<InferenceAccess & { canUpgrade: boolean }> = z.object({
  kind: z.enum(["paid", "free", "exhausted", "unavailable"]),
  modelID: z.string().nullable(),
  weeklyLimitUsd: usd,
  usedUsd: usd,
  reservedUsd: usd,
  remainingUsd: usd,
  resetsAt: z.iso.datetime().nullable(),
  reason: z.enum(INFERENCE_ACCESS_REASONS).nullable(),
  canUpgrade: z.boolean(),
  // Optional presentation data must never discard a valid entitlement response.
  catalog: z.array(managedModelRecommendationSchema).optional().catch(undefined),
  plan: z.object({
    name: z.string().trim().min(1),
    priceLabel: z.string().trim().min(1).nullable(),
    usageLabel: z.string().trim().min(1),
  }).optional().catch(undefined),
});

export type InferenceUpgradeReason = "free_allowance_exhausted" | "managed_model_requires_upgrade";

export function managedModelRecommendation(access: InferenceAccess | null, model: ModelRef) {
  return model.providerID === FREE_LUNA_MODEL.providerID
    ? access?.catalog?.find((item) => item.modelID === model.modelID)
    : undefined;
}

export function managedModelAccessLabel(access: InferenceAccess | null, model: ModelRef) {
  if (model.providerID !== FREE_LUNA_MODEL.providerID || !access) return null;
  if (access.kind === "paid") return "Included";
  if (access.kind !== "free" && access.kind !== "exhausted") return null;
  return model.modelID === access.modelID ? "Free" : "Upgrade";
}

export function managedModelRecommendations(access: InferenceAccess | null, options: readonly ModelOption[]) {
  const available = options.filter((option) => option.providerID === FREE_LUNA_MODEL.providerID && !option.disabled);
  if (!access?.catalog?.length) return [];
  const free = available.find((option) => option.modelID === (access.modelID ?? FREE_LUNA_MODEL.modelID));
  const recommendations = [...access.catalog].sort((a, b) => a.rank - b.rank)
    .filter((item) => item.recommended)
    .flatMap((item) => {
      const option = available.find((option) => option.modelID === item.modelID);
      return option ? [option] : [];
    });
  return [...new Map([...(free ? [free] : []), ...recommendations].map((option) => [option.modelID, option])).values()].slice(0, 4);
}

export function modelSelectionUpgradeReason(access: InferenceAccess | null, model: ModelRef): InferenceUpgradeReason | null {
  // Organization BYOK uses lpr_* identities, even when its provider is managed.
  if (model.providerID !== FREE_LUNA_MODEL.providerID || !access || (access.kind !== "free" && access.kind !== "exhausted")) return null;
  if (model.modelID !== access.modelID) return "managed_model_requires_upgrade";
  return access.kind === "exhausted" ? "free_allowance_exhausted" : null;
}

export function shouldSelectInitialLuna(input: {
  installationRequiresSignin: boolean;
  signedIn: boolean;
  access: InferenceAccess | null;
  modelAvailable: boolean;
  emptyFirstTask: boolean;
  setupComplete: boolean;
  explicitChoice: boolean;
  currentModel: ModelRef | null;
  variant: string | null;
}) {
  return input.installationRequiresSignin && input.signedIn && input.access?.kind === "free"
    && input.access.modelID === FREE_LUNA_MODEL.modelID && input.modelAvailable && input.emptyFirstTask
    && !input.setupComplete && !input.explicitChoice && input.variant === null
    && (!input.currentModel || (input.currentModel.providerID === "opencode" && input.currentModel.modelID === "big-pickle"));
}

export function markExplicitModelChoice() {
  try { window.localStorage.setItem(explicitModelChoiceKey, "1"); } catch { /* Storage can be unavailable. */ }
}

export function refreshInferenceAccess() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(inferenceAccessRefreshEvent));
}

export function formatAllowanceUsd(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

export function pendingInferenceUsageLabel(access: InferenceAccess) {
  if (access.reason !== "free_request_in_progress") return null;
  return `A Luna request is running or awaiting final usage.${access.reservedUsd !== null ? ` Estimated pending cost: ${formatAllowanceUsd(access.reservedUsd)}; the final charge may differ.` : ""} Wait for it to settle before starting another free request.`;
}

export function allowanceResetLabel(resetsAt: string | null | undefined) {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return null;
  return new Date(resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
