import type { InferenceRequestOutcome } from "./inference"

export type GatewayUsageGroupBy = "model" | "team" | "person"
export type GatewayUsageOption = { id: string; label: string }
export type GatewayUsageSeries = { id: string; label: string }
export type GatewayUsageDay = {
  date: string
  totalTokens: number
  values: Record<string, number>
  totalCostMicroUsd: number
  // Same sparse series IDs as values; null means a zero subtotal with missing or unknown cost coverage.
  costValues: Record<string, number | null>
}

export type GatewayUsageResponse = {
  usage: {
    groupBy: GatewayUsageGroupBy
    days: number
    from: string
    to: string
    timezone: "UTC"
    emptyReason?: "no_teams"
    // Includes completed request records of all outcomes, including rejections.
    // Optional while the web and API deployments roll out independently.
    requestCount?: number
    // Counts only records without total tokens. Null categories mean older
    // summaries did not retain that breakdown; optional during API rollout.
    uncountableRequests?: Record<InferenceRequestOutcome, number | null>
    totalTokens: number
    // Null means legacy rollup observation counts cannot establish completeness.
    unreportedRequests: number | null
    // Sum of known stored approximate costs, without historical repricing.
    totalCostMicroUsd: number
    // Null means legacy rollup cost observation counts cannot establish completeness.
    unpricedRequests: number | null
    series: GatewayUsageSeries[]
    daily: GatewayUsageDay[]
    filterOptions: GatewayUsageOption[]
  }
}
