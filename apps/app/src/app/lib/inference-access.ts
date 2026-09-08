import { INFERENCE_ACCESS_REASONS, type InferenceAccess, type ManagedModelRecommendation } from "@openwork/types/den/inference";
import { z } from "zod";
import { DESKTOP_FREE_PROVIDER_ID, DESKTOP_FREE_MODEL_ID, type DesktopFreeAccessStatus } from "@openwork/types/desktop-free-access";
import type { ModelOption, ModelRef } from "../types";

export const FREE_LUNA_MODEL: ModelRef = { providerID: "openwork", modelID: "openai/gpt-5.6-luna" };
export const DESKTOP_FREE_LUNA_MODEL: ModelRef = { providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID };
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
export const desktopFreeAccessStatusSchema: z.ZodType<DesktopFreeAccessStatus> = z.object({
  state: z.enum(["ready", "update_required", "unavailable", "exhausted"]),
  code: z.string().nullable(),
  currentVersion: z.string(),
  minimumVersion: z.string().nullable(),
  providerID: z.literal(DESKTOP_FREE_PROVIDER_ID),
  modelID: z.literal(DESKTOP_FREE_MODEL_ID),
  allowance: z.object({
    limitUsd: z.number().finite().nonnegative(),
    usedUsd: z.number().finite().nonnegative(),
    reservedUsd: z.number().finite().nonnegative(),
    remainingUsd: z.number().finite().nonnegative(),
    resetsAt: z.string(),
  }).nullable(),
  catalog: z.array(managedModelRecommendationSchema).optional().catch(undefined),
}).refine((status) => status.state !== "ready" || Boolean(status.minimumVersion?.trim() && status.allowance), "Ready free access needs a known version floor and allowance");

export function unavailableDesktopFreeStatus(): DesktopFreeAccessStatus {
  return { state: "unavailable", code: null, currentVersion: "", minimumVersion: null,
    providerID: DESKTOP_FREE_PROVIDER_ID, modelID: DESKTOP_FREE_MODEL_ID, allowance: null };
}

export function isDesktopFreeModel(model: ModelRef | null | undefined) {
  return model?.providerID === DESKTOP_FREE_PROVIDER_ID && model.modelID === DESKTOP_FREE_MODEL_ID;
}

export type DesktopFreeSubmissionBlock = { outcome: "blocked"; reason: "desktop-free-access"; status: DesktopFreeAccessStatus };

/** Never reuse a presentation status for admission, and never send after a scope change. */
export async function preflightDesktopFreeSubmission(input: {
  model: ModelRef | null | undefined;
  client: { desktopFreePreflight: () => Promise<DesktopFreeAccessStatus> } | null;
  isCurrent: () => boolean;
  onBlocked: (status: DesktopFreeAccessStatus) => void;
}): Promise<DesktopFreeSubmissionBlock | { outcome: "cancelled"; reason: "context_changed" } | null> {
  if (!isDesktopFreeModel(input.model)) return null;
  if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" };
  const status = await input.client?.desktopFreePreflight().catch(() => unavailableDesktopFreeStatus()) ?? unavailableDesktopFreeStatus();
  if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" };
  if (status.state === "ready") return null;
  input.onBlocked(status);
  return { outcome: "blocked", reason: "desktop-free-access", status };
}

/** API admission errors and later engine errors may wrap the same typed status. */
export function desktopFreeStatusFromError(value: unknown, depth = 0): DesktopFreeAccessStatus | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === "string") {
    if (value.length > 65_536 || !value.trimStart().startsWith("{")) return null;
    try { return desktopFreeStatusFromError(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (typeof value !== "object") return null;
  const parsed = desktopFreeAccessStatusSchema.safeParse(value);
  if (parsed.success && parsed.data.state !== "ready") return parsed.data;
  for (const key of ["details", "error", "data", "responseBody", "message", "cause"]) {
    const nested = desktopFreeStatusFromError(Reflect.get(value, key), depth + 1);
    if (nested) return nested;
  }
  const code = Reflect.get(value, "code");
  if (typeof code !== "string" || !["desktop_update_required", "desktop_version_unavailable", "anonymous_limit_exceeded", "anonymous_reservation_does_not_fit", "anonymous_capacity_exceeded", "anonymous_unavailable"].includes(code)) return null;
  const currentVersion = Reflect.get(value, "currentVersion");
  const minimumVersion = Reflect.get(value, "minimumVersion");
  return { ...unavailableDesktopFreeStatus(), code,
    state: code === "desktop_update_required" ? "update_required"
      : code === "anonymous_limit_exceeded" || code === "anonymous_reservation_does_not_fit" ? "exhausted" : "unavailable",
    currentVersion: typeof currentVersion === "string" ? currentVersion : "",
    minimumVersion: typeof minimumVersion === "string" ? minimumVersion : null };
}

export function desktopFreeNotice(status: DesktopFreeAccessStatus, beforeAcceptance = true) {
  const update = status.state === "update_required";
  const exhausted = status.state === "exhausted";
  const reset = allowanceResetLabel(status.allowance?.resetsAt);
  const positiveBalance = (status.allowance?.remainingUsd ?? 0) > 0;
  const title = update ? "Update OpenWork to use free Luna"
    : exhausted ? positiveBalance ? "This request exceeds the available free Luna allowance" : "Free Luna allowance reached"
    : "Free Luna temporarily unavailable";
  const detail = update
    ? [status.currentVersion ? `Current version: ${status.currentVersion}.` : "", status.minimumVersion ? `Required version: ${status.minimumVersion}.` : ""].filter(Boolean).join(" ")
    : exhausted ? `USD 1 per week per installation.${positiveBalance ? ` Estimated remaining: ${formatAllowanceUsd(status.allowance!.remainingUsd)}. A safety hold for this request may not fit.` : ""}${reset ? ` Resets ${reset}.` : ""}`
    : "Free Luna could not be verified. Try again later or use your own provider.";
  return { title, body: `${detail}${detail ? " " : ""}${beforeAcceptance ? "Your message has not been sent. Your draft is unchanged." : "This turn failed. No message will be retried automatically."}` };
}
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

export function modelPickerView(options: readonly ModelOption[], input: {
  access: InferenceAccess | null;
  signedIn: boolean;
  target: "session" | "default";
  desktopFree?: boolean;
}) {
  const managedOnly = input.target === "session" && (input.desktopFree || (input.signedIn
    && (input.access?.kind === "free" || input.access?.kind === "exhausted" || input.access?.kind === "paid")));
  // This is a view filter, not a provider restriction or a change to saved choices.
  const visible = input.desktopFree && input.access?.kind !== "paid"
    ? options.filter((option) => option.providerID !== "openwork") : options;
  return { managedOnly: Boolean(managedOnly), options: managedOnly ? visible.filter((option) => option.providerID === "openwork" || option.providerID === DESKTOP_FREE_PROVIDER_ID) : visible };
}

export function managedModelRecommendation(access: InferenceAccess | null, model: ModelRef) {
  return (model.providerID === FREE_LUNA_MODEL.providerID || isDesktopFreeModel(model))
    ? access?.catalog?.find((item) => item.modelID === model.modelID)
    : undefined;
}

export function managedModelAccessLabel(access: InferenceAccess | null, model: ModelRef) {
  if (isDesktopFreeModel(model)) return "Free";
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
  eligible: boolean;
  status: DesktopFreeAccessStatus | null;
  modelAvailable: boolean;
  emptyFirstTask: boolean;
  setupComplete: boolean;
  explicitChoice: boolean;
  currentModel: ModelRef | null;
  variant: string | null;
}) {
  return input.eligible && input.status?.state === "ready" && input.modelAvailable && input.emptyFirstTask
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
