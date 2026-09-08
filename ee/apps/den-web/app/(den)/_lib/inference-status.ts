import { INFERENCE_ACCESS_REASONS, type InferenceAccess } from "@openwork/types/den/inference";
import { z } from "zod";

const usd = z.number().finite().nonnegative().nullable();
const accessSchema: z.ZodType<InferenceAccess & { canUpgrade: boolean }> = z.object({
  kind: z.enum(["paid", "free", "exhausted", "unavailable"]),
  modelID: z.string().nullable(),
  weeklyLimitUsd: usd, usedUsd: usd, reservedUsd: usd, remainingUsd: usd,
  resetsAt: z.iso.datetime().nullable(),
  reason: z.enum(INFERENCE_ACCESS_REASONS).nullable(),
  canUpgrade: z.boolean(),
});

export function parseInferenceAccessPayload(payload: unknown) {
  const parsed = z.object({ access: accessSchema }).safeParse(payload);
  return parsed.success ? parsed.data.access : null;
}

export function freeAllowanceDescription(access: InferenceAccess | null) {
  if (!access || (access.kind !== "free" && access.kind !== "exhausted")) return null;
  const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  const balance = access.remainingUsd !== null && access.weeklyLimitUsd !== null
    ? `${usd(access.remainingUsd)} of ${usd(access.weeklyLimitUsd)} remaining per person this week.` : "Weekly allowance status is unavailable.";
  const reset = access.resetsAt && Number.isFinite(Date.parse(access.resetsAt))
    ? ` Resets ${new Date(access.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" })}.` : "";
  const pending = access.reason === "free_request_in_progress"
    ? ` A Luna request is running or awaiting final usage.${access.reservedUsd !== null ? ` Estimated pending cost: ${usd(access.reservedUsd)}; the final charge may differ.` : ""} Wait for it to settle before starting another free request.` : "";
  return `Free standard Luna. ${balance}${reset}${pending}`;
}

type InferenceWindowType = "five_hour" | "weekly" | "monthly";

export type InferenceUsageBucket = {
  windowType: InferenceWindowType;
  windowStartAt: string;
  windowEndAt: string;
  limitAmount: number;
  usedAmount: number;
};

export type InferenceStatus = {
  enabled: boolean;
  tier: "tier1" | "tier2";
  memberCount: number;
  proxyBaseUrl: string;
  upstreamProviderConfigured: boolean;
  subscribed: boolean;
  buckets: InferenceUsageBucket[];
};

function isWindowType(value: unknown): value is InferenceWindowType {
  return value === "five_hour" || value === "weekly" || value === "monthly";
}

function parseUsageBuckets(value: unknown): InferenceUsageBucket[] {
  if (!Array.isArray(value)) return [];
  const buckets: InferenceUsageBucket[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<InferenceUsageBucket>;
    if (
      !isWindowType(candidate.windowType) ||
      typeof candidate.windowStartAt !== "string" ||
      typeof candidate.windowEndAt !== "string" ||
      typeof candidate.limitAmount !== "number" ||
      typeof candidate.usedAmount !== "number"
    ) {
      continue;
    }
    buckets.push({
      windowType: candidate.windowType,
      windowStartAt: candidate.windowStartAt,
      windowEndAt: candidate.windowEndAt,
      limitAmount: candidate.limitAmount,
      usedAmount: candidate.usedAmount,
    });
  }
  return buckets;
}

export function parseInferencePayload(payload: unknown): InferenceStatus | null {
  if (!payload || typeof payload !== "object" || !("inference" in payload)) {
    return null;
  }
  const inference = (payload as { inference?: unknown }).inference;
  if (!inference || typeof inference !== "object") {
    return null;
  }
  const value = inference as Partial<InferenceStatus> & { buckets?: unknown };
  if (typeof value.enabled !== "boolean" || (value.tier !== "tier1" && value.tier !== "tier2")) {
    return null;
  }
  return {
    enabled: value.enabled,
    tier: value.tier,
    memberCount: typeof value.memberCount === "number" ? value.memberCount : 0,
    proxyBaseUrl: typeof value.proxyBaseUrl === "string" ? value.proxyBaseUrl : "",
    upstreamProviderConfigured: value.upstreamProviderConfigured === true,
    subscribed: value.subscribed === true,
    buckets: parseUsageBuckets(value.buckets),
  };
}
