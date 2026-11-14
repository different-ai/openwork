import { z } from "zod"
import type { GatewayUsageResponse } from "./gateway-usage"
import type { GatewayUsageBucket, GatewayUsageStatus } from "./gateway-usage-limits"

/**
 * A member's own AI Gateway usage (`GET /v1/gateway/usage/me`): the same daily
 * model report the admin usage screen reads, scoped to the caller, plus the
 * token mix and the models they can use with listed prices. The helpers below
 * turn it into the figures the My Usage page (Den Web) and the desktop Usage
 * settings show, so both say the same thing.
 */

export const GATEWAY_MEMBER_USAGE_DAYS = 30

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const identitySchema = z.object({ id: z.string().min(1), label: z.string().min(1) })
const nullableCount = countSchema.nullable()

/** One member's usage by model, in the same shape as `GatewayUsageResponse["usage"]`. */
export const gatewayMemberUsageReportSchema: z.ZodType<GatewayUsageResponse["usage"]> = z.object({
  groupBy: z.enum(["model", "team", "person"]),
  days: z.number().int().min(1).max(366),
  from: z.iso.date(),
  to: z.iso.date(),
  timezone: z.literal("UTC"),
  emptyReason: z.literal("no_teams").optional(),
  requestCount: countSchema.optional(),
  uncountableRequests: z.object({
    ok: nullableCount, upstream_error: nullableCount, upstream_unreachable: nullableCount,
    client_aborted: nullableCount, rejected: nullableCount,
  }).optional(),
  totalTokens: countSchema,
  unreportedRequests: nullableCount,
  totalCostMicroUsd: countSchema,
  unpricedRequests: nullableCount,
  series: z.array(identitySchema),
  daily: z.array(z.object({
    date: z.iso.date(),
    totalTokens: countSchema,
    values: z.record(z.string(), countSchema),
    totalCostMicroUsd: countSchema,
    costValues: z.record(z.string(), nullableCount),
  })),
  filterOptions: z.array(identitySchema),
})

/**
 * The tokens behind one usage series, split the way prices are listed.
 * Only requests that reported both input and output tokens count here
 * (`measuredRequests`); uncached input already excludes cache reads and writes.
 */
export const gatewayMemberTokenMixSchema = z.object({
  seriesId: z.string().min(1),
  measuredRequests: countSchema,
  uncachedInputTokens: countSchema,
  outputTokens: countSchema,
  cacheReadTokens: countSchema,
  cacheWriteTokens: countSchema,
})
export type GatewayMemberTokenMix = z.infer<typeof gatewayMemberTokenMixSchema>

const priceSchema = z.number().min(0).max(1_000_000)
const basePriceSchema = z.object({
  input: priceSchema,
  output: priceSchema,
  cacheRead: priceSchema.nullable(),
  cacheWrite: priceSchema.nullable(),
})
/** A listed price in USD per 1M tokens, which is also micro-USD per token. */
export const gatewayListedPriceSchema = basePriceSchema.extend({
  /** Prices that apply once a request's context is above `above` tokens, lowest first. */
  contextTiers: z.array(basePriceSchema.extend({ above: countSchema })),
})
export type GatewayListedPrice = z.infer<typeof gatewayListedPriceSchema>

export const gatewayMemberModelSchema = z.object({
  /** The Gateway model alias the member picks (`gwm_…`). */
  id: z.string().min(1),
  name: z.string().min(1),
  providerName: z.string().min(1),
  /** The catalog provider, such as `anthropic`. */
  providerId: z.string().min(1),
  upstreamModelId: z.string().min(1),
  /** The usage series this model reports under, to match it with spend. */
  seriesId: z.string().min(1),
  price: gatewayListedPriceSchema.nullable(),
})
export type GatewayMemberModel = z.infer<typeof gatewayMemberModelSchema>

export const gatewayMemberUsageResponseSchema = z.object({
  usage: gatewayMemberUsageReportSchema,
  tokenMix: z.array(gatewayMemberTokenMixSchema),
  models: z.array(gatewayMemberModelSchema),
})
export type GatewayMemberUsageResponse = z.infer<typeof gatewayMemberUsageResponseSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readPrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null
}

function readBasePrice(cost: Record<string, unknown>) {
  const input = readPrice(cost.input)
  const output = readPrice(cost.output)
  if (input === null || output === null) return null
  return { input, output, cacheRead: readPrice(cost.cache_read), cacheWrite: readPrice(cost.cache_write) }
}

/**
 * The listed price in a models.dev-shaped model config (`config.cost`, USD per
 * 1M tokens), the same fields the Gateway bills with. Null without a price.
 */
export function readGatewayListedPrice(config: unknown): GatewayListedPrice | null {
  if (!isRecord(config) || !isRecord(config.cost)) return null
  const cost = config.cost
  const base = readBasePrice(cost)
  if (!base) return null
  const contextTiers: GatewayListedPrice["contextTiers"] = []
  if (Array.isArray(cost.tiers)) {
    for (const entry of cost.tiers) {
      if (!isRecord(entry) || !isRecord(entry.tier) || entry.tier.type !== "context") continue
      const above = readPrice(entry.tier.size)
      const price = readBasePrice({ ...cost, ...entry })
      if (above !== null && Number.isSafeInteger(above) && price) contextTiers.push({ above, ...price })
    }
  } else if (isRecord(cost.context_over_200k)) {
    // Older catalog snapshots predate the explicit tier threshold.
    const price = readBasePrice({ ...cost, ...cost.context_over_200k })
    if (price) contextTiers.push({ above: 200_000, ...price })
  }
  return { ...base, contextTiers: contextTiers.sort((a, b) => a.above - b.above) }
}

const EMPTY_MIX: Omit<GatewayMemberTokenMix, "seriesId"> = {
  measuredRequests: 0, uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
}

/** All of a member's token mixes added together. */
export function totalGatewayTokenMix(mixes: readonly GatewayMemberTokenMix[]): GatewayMemberTokenMix {
  const total = { seriesId: "all", ...EMPTY_MIX }
  for (const mix of mixes) {
    total.measuredRequests += mix.measuredRequests
    total.uncachedInputTokens += mix.uncachedInputTokens
    total.outputTokens += mix.outputTokens
    total.cacheReadTokens += mix.cacheReadTokens
    total.cacheWriteTokens += mix.cacheWriteTokens
  }
  return total
}

/**
 * What a token mix costs at a listed price, in micro-USD. Context tiers apply
 * by the average context per measured request, since requests are summed.
 */
export function estimateGatewayTokenMixCost(mix: Omit<GatewayMemberTokenMix, "seriesId">, price: GatewayListedPrice): number {
  const context = mix.uncachedInputTokens + mix.cacheReadTokens + mix.cacheWriteTokens
  const averageContext = mix.measuredRequests > 0 ? context / mix.measuredRequests : 0
  let applied: Omit<GatewayListedPrice, "contextTiers"> = price
  for (const tier of price.contextTiers) if (averageContext > tier.above) applied = tier
  const microUsd = mix.uncachedInputTokens * applied.input
    + mix.outputTokens * applied.output
    + mix.cacheReadTokens * (applied.cacheRead ?? applied.input)
    + mix.cacheWriteTokens * (applied.cacheWrite ?? applied.input)
  return Math.round(microUsd)
}

export type GatewayMemberSeriesTotal = {
  id: string
  label: string
  costMicroUsd: number
  tokens: number
  /** Some of this series' cost is not known (requests without a price). */
  unpriced: boolean
}

/** Spend and tokens per model over the whole period, highest spend first. */
export function gatewayMemberSeriesTotals(usage: GatewayUsageResponse["usage"]): GatewayMemberSeriesTotal[] {
  return usage.series.map((series) => {
    let costMicroUsd = 0
    let tokens = 0
    let unpriced = false
    for (const day of usage.daily) {
      tokens += day.values[series.id] ?? 0
      const cost = day.costValues[series.id]
      if (cost === null) unpriced = true
      else costMicroUsd += cost ?? 0
    }
    return { id: series.id, label: series.label, costMicroUsd, tokens, unpriced }
  }).filter((total) => total.costMicroUsd > 0 || total.tokens > 0)
    .sort((a, b) => b.costMicroUsd - a.costMicroUsd || b.tokens - a.tokens || a.label.localeCompare(b.label, "en"))
}

export type GatewayMemberUsageMetrics = {
  /** Recorded spend, or null when nothing has a price yet but requests were made. */
  spendMicroUsd: number | null
  /** Requests without a price are left out of spend; null when older records can't tell. */
  unpricedRequests: number | null
  requests: number | null
  tokens: number
  topModel: GatewayMemberSeriesTotal | null
}

/** The key figures at the top of My Usage. */
export function gatewayMemberUsageMetrics(usage: GatewayUsageResponse["usage"]): GatewayMemberUsageMetrics {
  const totals = gatewayMemberSeriesTotals(usage)
  // Never present unobserved cost as free: $0 with requests missing a price is unknown.
  const unknownSpend = usage.totalCostMicroUsd === 0 && usage.unpricedRequests !== 0 && (usage.requestCount ?? usage.totalTokens) > 0
  return {
    spendMicroUsd: unknownSpend ? null : usage.totalCostMicroUsd,
    unpricedRequests: usage.unpricedRequests,
    requests: usage.requestCount ?? null,
    tokens: usage.totalTokens,
    topModel: totals[0] ?? null,
  }
}

export type GatewayModelCostRow = {
  model: GatewayMemberModel
  /** What the member's measured tokens would have cost on this model; null without a listed price. */
  estimateMicroUsd: number | null
  /** The member used this model in the period. */
  inUse: boolean
  /** Recorded spend on this model in the period. */
  spentMicroUsd: number
}

export type GatewayModelCostComparison = {
  mix: GatewayMemberTokenMix
  /** Requests whose tokens were not reported, so the estimate leaves them out. */
  unmeasuredRequests: number | null
  rows: GatewayModelCostRow[]
}

/**
 * Each usable model with what the member's last 30 days would have cost on it:
 * their measured token mix times the model's listed price. Cheapest first;
 * models without a listed price last. Models used in the period are marked.
 */
export function gatewayModelCostComparison(response: GatewayMemberUsageResponse): GatewayModelCostComparison {
  const mix = totalGatewayTokenMix(response.tokenMix)
  const spend = new Map(gatewayMemberSeriesTotals(response.usage).map((total) => [total.id, total]))
  const seen = new Set<string>()
  const rows: GatewayModelCostRow[] = []
  for (const model of response.models) {
    // The same upstream model can reach a member through several groups.
    const key = `${model.providerName}\u001f${model.seriesId}`
    if (seen.has(key)) continue
    seen.add(key)
    const used = spend.get(model.seriesId)
    rows.push({
      model,
      estimateMicroUsd: model.price ? estimateGatewayTokenMixCost(mix, model.price) : null,
      inUse: Boolean(used),
      spentMicroUsd: used?.costMicroUsd ?? 0,
    })
  }
  rows.sort((a, b) => {
    if (a.estimateMicroUsd === null || b.estimateMicroUsd === null) {
      if (a.estimateMicroUsd !== b.estimateMicroUsd) return a.estimateMicroUsd === null ? 1 : -1
    } else if (a.estimateMicroUsd !== b.estimateMicroUsd) return a.estimateMicroUsd - b.estimateMicroUsd
    return a.model.name.localeCompare(b.model.name, "en") || a.model.providerName.localeCompare(b.model.providerName, "en")
  })
  const requests = response.usage.requestCount
  return {
    mix,
    unmeasuredRequests: requests === undefined ? null : Math.max(0, requests - mix.measuredRequests),
    rows,
  }
}

/*
 * Spend-limit copy, shared by the desktop Usage settings and Den Web's My Usage
 * so both surfaces describe a limit the same way.
 */

export function formatGatewayMoney(microUsd: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(microUsd / 1_000_000)
}

/** Whole cents for figures (spend, estimates); tiny nonzero amounts say "<$0.01" instead of "$0.00". */
export function formatGatewaySpend(microUsd: number): string {
  if (microUsd > 0 && microUsd < 5_000) return "<$0.01"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(microUsd / 1_000_000)
}

export const gatewayPeriodLabels: Record<GatewayUsageBucket["timeframe"], string> = { day: "Today", week: "This week", month: "This month" }
export const gatewayPeriodPossessives: Record<GatewayUsageBucket["timeframe"], string> = { day: "today’s", week: "this week’s", month: "this month’s" }

/** What an approved increase adds; mirrors the Den approval (a quarter of the base, rounded up). */
export function gatewayIncreaseMicroUsd(bucket: Pick<GatewayUsageBucket, "baseAllowanceMicroUsd">): number {
  return Math.ceil(bucket.baseAllowanceMicroUsd / 4)
}

export function gatewayPercentLeft(bucket: Pick<GatewayUsageBucket, "allowanceMicroUsd" | "usedMicroUsd">): number {
  if (bucket.allowanceMicroUsd <= 0) return 0
  const left = Math.max(0, bucket.allowanceMicroUsd - bucket.usedMicroUsd)
  return Math.min(100, Math.floor((left * 100) / bucket.allowanceMicroUsd))
}

export function formatGatewayReset(resetAt: string, now: number): string {
  const ms = Date.parse(resetAt) - now
  if (ms < 60 * 60_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000))
    return `Resets in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  }
  if (ms < 24 * 60 * 60_000) {
    const hours = Math.round(ms / (60 * 60_000))
    return `Resets in ${hours} ${hours === 1 ? "hour" : "hours"}`
  }
  return `Resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(resetAt))}`
}

/** The bucket is used up: at or past its allowance. */
export function gatewayBucketExhausted(bucket: Pick<GatewayUsageBucket, "usedMicroUsd" | "allowanceMicroUsd">): boolean {
  return bucket.usedMicroUsd >= bucket.allowanceMicroUsd
}

/** The member can ask an admin for more on this bucket now. */
export function gatewayCanAskForMore(bucket: GatewayUsageBucket): boolean {
  return bucket.allowRequestReset && bucket.canRequestReset && bucket.resetRequestStatus !== "pending" && gatewayBucketExhausted(bucket)
}

export type GatewayUsageLimitGroup = {
  key: string
  /** Null for the default limit; the provider's name for a provider limit. */
  providerName: string | null
  buckets: GatewayUsageBucket[]
}

/**
 * The member's limits as separate items: the default limit when one is set,
 * then one item per provider limit. Empty means no limit at all.
 */
export function gatewayUsageLimitGroups(status: Pick<GatewayUsageStatus, "buckets" | "providers">): GatewayUsageLimitGroup[] {
  return [
    ...(status.buckets.length ? [{ key: "default", providerName: null, buckets: status.buckets }] : []),
    ...(status.providers ?? []).filter((provider) => provider.buckets.length)
      .map((provider) => ({ key: provider.providerId, providerName: provider.providerName, buckets: provider.buckets })),
  ]
}

/** "$1.25 per 1M input · $10.00 per 1M output" style price, or null without one. */
export function formatGatewayListedPrice(price: GatewayListedPrice | null): { input: string; output: string } | null {
  if (!price) return null
  const usd = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  return { input: usd(price.input), output: usd(price.output) }
}
