import { z } from "zod";
import { GATEWAY_USAGE_LIMIT_ERROR_CODE, hasGatewayUsageLimitHttpMarker, gatewayUsageTimeframeSchema, type GatewayUsageBucket, type GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";

// Limit copy lives with Den Web's My Usage page so both surfaces say the same thing.
export {
  formatGatewayMoney,
  formatGatewayReset,
  gatewayIncreaseMicroUsd,
  gatewayPercentLeft,
  gatewayPeriodLabels,
  gatewayPeriodPossessives,
  gatewayUsageLimitGroups,
  type GatewayUsageLimitGroup,
} from "@openwork/types/den/gateway-member-usage";

export const gatewayUsageQueryPrefix = ["gateway-own-usage"];

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const gatewayUsageErrorDetailsSchema = z.object({
  exhaustedBuckets: z.array(z.object({
    bucketId: z.string().min(1), timeframe: gatewayUsageTimeframeSchema,
    usedMicroUsd: money, allowanceMicroUsd: money, resetAt: z.iso.datetime(),
    hardLimit: z.literal(true), allowRequestReset: z.boolean(),
  }).refine((bucket) => bucket.usedMicroUsd >= bucket.allowanceMicroUsd)).min(1).max(3),
  retryAt: z.iso.datetime(),
  /** Set when a provider limit (not the default) blocked the request. */
  provider: z.object({ id: z.string().min(1).max(64), name: z.string().max(255) }).optional(),
});
export const gatewayUsageErrorEvidenceSchema = z.object({
  statusCode: z.literal(429),
  responseHeaders: z.object({
    "x-openwork-error-code": z.literal(GATEWAY_USAGE_LIMIT_ERROR_CODE),
    "x-openwork-usage-state": z.literal("blocked"),
  }).strict(),
  details: gatewayUsageErrorDetailsSchema,
});
export type GatewayUsageErrorEvidence = z.infer<typeof gatewayUsageErrorEvidenceSchema>;
const envelope = z.object({ error: z.object({
  code: z.literal(GATEWAY_USAGE_LIMIT_ERROR_CODE), source: z.literal("openwork_gateway"),
  type: z.literal("usage_limit_error"), details: gatewayUsageErrorDetailsSchema,
}) });

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

export function parseGatewayUsageError(value: unknown): GatewayUsageErrorEvidence | null {
  const records = [value, field(value, "data"), field(value, "cause"), field(field(value, "cause"), "data")];
  const statuses = records.flatMap((record) => [field(record, "statusCode"), field(record, "status"), field(field(record, "response"), "status")]);
  if (statuses.some((status) => typeof status === "number" && status !== 429)) return null;
  for (const record of records) {
    if (field(record, "statusCode") !== 429 && field(record, "status") !== 429) continue;
    const rawHeaders = field(record, "responseHeaders");
    const headers = rawHeaders instanceof Headers ? rawHeaders : new Headers();
    if (!(rawHeaders instanceof Headers) && rawHeaders && typeof rawHeaders === "object") {
      for (const [name, value] of Object.entries(rawHeaders)) {
        const key = name.toLowerCase();
        if (key !== "x-openwork-error-code" && key !== "x-openwork-usage-state") continue;
        if (typeof value !== "string") return null;
        try { headers.append(key, value); } catch { return null; }
      }
    }
    if (!hasGatewayUsageLimitHttpMarker({ status: 429, headers })) continue;
    const body = field(record, "responseBody");
    if (typeof body !== "string" || body.length > 32_000) continue;
    try {
      const parsed = envelope.safeParse(JSON.parse(body));
      if (parsed.success) return {
        statusCode: 429,
        responseHeaders: { "x-openwork-error-code": GATEWAY_USAGE_LIMIT_ERROR_CODE, "x-openwork-usage-state": "blocked" },
        details: parsed.data.error.details,
      };
    } catch { continue; }
  }
  return null;
}

export function isGatewayUsageModel(providerId: string, gatewayProviderIds?: ReadonlySet<string>): boolean {
  return providerId !== "openwork" && gatewayProviderIds?.has(providerId) === true;
}

export function gatewayUsageNoticeState(input: {
  gatewaySelected: boolean;
  status?: GatewayUsageStatus;
}): "blocked" | "over_limit" | null {
  if (!input.gatewaySelected) return null;
  return input.status?.state === "blocked" || input.status?.state === "over_limit" ? input.status.state : null;
}

export function corroboratesGatewayUsageError(evidence: GatewayUsageErrorEvidence | null, status?: GatewayUsageStatus): boolean {
  return Boolean(evidence && status?.state === "blocked" && evidence.details.exhaustedBuckets.every((exhausted) =>
    status.buckets.some((bucket) => bucket.id === exhausted.bucketId && bucket.hardLimit && bucket.usedMicroUsd >= bucket.allowanceMicroUsd),
  ));
}

/** Every bucket the member has: default limits and each provider limit. */
export function allGatewayUsageBuckets(status: Pick<GatewayUsageStatus, "buckets" | "providers">): GatewayUsageBucket[] {
  return [...status.buckets, ...(status.providers ?? []).flatMap((provider) => provider.buckets)];
}

export type GatewayUsageScopeView = {
  /** The status as the selected model sees it: its provider limit, or the default limits. */
  status: GatewayUsageStatus;
  /** Set when a provider limit governs the selected model. */
  providerName: string | null;
};

/**
 * The limits that govern requests to one Gateway provider. A provider limit
 * replaces the default for that provider; every other provider uses the default.
 */
export function gatewayUsageForProvider(status: GatewayUsageStatus, gatewayProviderId: string | null | undefined): GatewayUsageScopeView {
  const provider = gatewayProviderId ? status.providers?.find((entry) => entry.providerId === gatewayProviderId) : undefined;
  if (!provider) return { status, providerName: null };
  return { status: { ...status, state: provider.state, buckets: provider.buckets }, providerName: provider.providerName };
}

/** Whether another Gateway provider the member has is not paused, so switching models would help. */
export function gatewayUsageCanSwitchProvider(
  status: GatewayUsageStatus | undefined,
  selectedProviderId: string | null | undefined,
  gatewayProviderIds: Iterable<string> | undefined,
): boolean {
  if (!status || !gatewayProviderIds) return false;
  const selected = gatewayUsageForProvider(status, selectedProviderId).status.state;
  if (selected !== "blocked") return false;
  return [...new Set(gatewayProviderIds)].some((providerId) =>
    providerId !== selectedProviderId && gatewayUsageForProvider(status, providerId).status.state !== "blocked");
}

export function gatewayUsageRefreshKey(input: {
  sessionOwner: string;
  providerId: string;
  modelId: string;
  runState: string;
  latestMessageId?: string;
  errorKey?: string;
}): string {
  return JSON.stringify([input.sessionOwner, input.providerId, input.modelId, input.runState,
    input.runState === "idle" ? input.latestMessageId ?? null : null, input.errorKey ?? null]);
}

export function gatewayUsageResetDelay(status: GatewayUsageStatus, receivedAt: number, now: number): number | null {
  const buckets = allGatewayUsageBuckets(status);
  if (!buckets.length) return null;
  const remaining = Math.min(...buckets.map((bucket) => Date.parse(bucket.resetAt))) - Date.parse(status.serverTime) - Math.max(0, now - receivedAt);
  return Math.min(2_147_483_647, Math.max(1000, remaining + 250));
}
