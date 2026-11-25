import type { InferenceRequestOutcome } from "./inference"

export type GatewayUsageGroupBy = "model" | "team" | "person"
export type GatewayUsageOption = { id: string; label: string }
export type GatewayUsageSeries = { id: string; label: string }
export type GatewayUsageDay = {
  date: string
  totalTokens: number
  values: Record<string, number>
  totalCostMicroUsd: number
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
    requestCount?: number
    uncountableRequests?: Record<InferenceRequestOutcome, number | null>
    totalTokens: number
    unreportedRequests: number | null
    totalCostMicroUsd: number
    unpricedRequests: number | null
    series: GatewayUsageSeries[]
    daily: GatewayUsageDay[]
    filterOptions: GatewayUsageOption[]
  }
}
