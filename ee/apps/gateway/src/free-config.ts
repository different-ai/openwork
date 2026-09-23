import { INFERENCE_USAGE_CONVERSION_FACTOR, readFreeInferenceConfig } from "@openwork/types/den/inference"
import { DESKTOP_FREE_RELEASES_URL } from "./desktop-free-version.js"

export const FREE_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
const DEFAULT_FREE_OPENAI_MODEL = "gpt-5.6-luna"

export function readAutoConfig(environment: Record<string, string | undefined>) {
  const member = readFreeInferenceConfig(environment)
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const raw = environment[name]
    const value = Number(raw ?? fallback)
    if (raw?.trim() === "" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
    return value
  }
  const flag = (name: string) => {
    const value = environment[name] ?? "false"
    if (!["true", "false", "1", "0"].includes(value)) throw new Error(`Invalid ${name}`)
    return value === "true" || value === "1"
  }
  const deviceWeeklyAmount = integer("ANONYMOUS_INSTALL_WEEKLY_MICRO_USD", 1000000, 1, 100000000) * 100
  if (member.enabled && member.weeklyLimitAmount <= deviceWeeklyAmount) throw new Error("Member free budget must exceed the device budget")
  // One dedicated OpenAI key serves every free request. Revoking it at OpenAI is
  // the kill switch, and its OpenAI usage page is the true cost over time.
  const apiKey = environment.INFERENCE_FREE_OPENAI_API_KEY?.trim() || ""
  const upstreamModel = environment.INFERENCE_FREE_OPENAI_MODEL?.trim() || DEFAULT_FREE_OPENAI_MODEL
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(upstreamModel)) throw new Error("Invalid INFERENCE_FREE_OPENAI_MODEL")
  const tokenSecret = environment.ANONYMOUS_TOKEN_SECRET?.trim() || ""
  const accountingIdentityKey = environment.ANONYMOUS_ACCOUNTING_IDENTITY_KEY?.trim() || ""
  const ready = Boolean(apiKey && accountingIdentityKey.length >= 32)
  // Guests must come from a supported desktop release. Each stable release derives
  // its own secret from this master key at build time; rotate with a _PREVIOUS overlap.
  const releaseKey = environment.DESKTOP_FREE_RELEASE_KEY?.trim() || ""
  const releaseKeyPrevious = environment.DESKTOP_FREE_RELEASE_KEY_PREVIOUS?.trim() || ""
  const devMode = environment.OPENWORK_DEV_MODE === "1" && environment.NODE_ENV !== "production"
  const devReleaseSecret = devMode ? environment.DESKTOP_FREE_DEV_RELEASE_SECRET?.trim() || "" : ""
  const distinct = new Set([releaseKey, releaseKeyPrevious, devReleaseSecret, tokenSecret, accountingIdentityKey].filter(Boolean))
  if (distinct.size !== [releaseKey, releaseKeyPrevious, devReleaseSecret, tokenSecret, accountingIdentityKey].filter(Boolean).length) throw new Error("Free Auto secrets must be distinct")
  const version = (name: string) => {
    const value = environment[name]?.trim()
    if (value !== undefined && value !== "" && !/^\d+\.\d+\.\d+$/.test(value)) throw new Error(`Invalid ${name}`)
    return value || null
  }
  return {
    member, memberEnabled: member.enabled && ready,
    anonymousEnabled: flag("ANONYMOUS_INFERENCE_ENABLED") && ready && tokenSecret.length >= 32 && tokenSecret !== accountingIdentityKey && releaseKey.length >= 32,
    apiKey, upstreamModel, tokenSecret, accountingIdentityKey,
    releaseKey, releaseKeyPrevious: releaseKeyPrevious.length >= 32 ? releaseKeyPrevious : "",
    devReleaseSecret: devReleaseSecret.length >= 32 ? devReleaseSecret : "",
    /** Once every supported release is at or above this version, v2 proofs (no release tag) are refused. */
    firstReleaseTagVersion: version("DESKTOP_FREE_FIRST_RELEASE_TAG_VERSION"),
    releasesUrl: environment.DESKTOP_FREE_APP_VERSION_URL ?? DESKTOP_FREE_RELEASES_URL,
    supportedReleaseCount: integer("DESKTOP_FREE_SUPPORTED_RELEASE_COUNT", 3, 1, 20),
    supportedReleaseMinDays: integer("DESKTOP_FREE_SUPPORTED_RELEASE_MIN_DAYS", 14, 0, 365),
    blockedReleases: (environment.DESKTOP_FREE_BLOCKED_RELEASES ?? "").split(",").map((value) => value.trim().replace(/^v/, "")).filter(Boolean),
    deviceWeeklyAmount,
    ipDailyAmount: integer("ANONYMOUS_IP_DAILY_MICRO_USD", 5000000, 1, 100000000) * 100,
    globalDailyAmount: integer("ANONYMOUS_GLOBAL_DAILY_MICRO_USD", 100000000, 1, 1000000000) * 100,
    globalMonthlyAmount: integer("ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD", 3000000000, 1, 10000000000) * 100,
    memberGlobalDailyAmount: integer("INFERENCE_FREE_GLOBAL_DAILY_MICRO_USD", 100000000, 1, 1000000000) * 100,
    memberGlobalMonthlyAmount: integer("INFERENCE_FREE_GLOBAL_MONTHLY_MICRO_USD", 3000000000, 1, 10000000000) * 100,
    globalInflight: integer("ANONYMOUS_GLOBAL_INFLIGHT", 20, 1, 1000),
    tokenTtlSeconds: integer("ANONYMOUS_TOKEN_TTL_SECONDS", 3600, 60, 86400),
    requestTimeoutMs: integer("ANONYMOUS_REQUEST_TIMEOUT_MS", 60000, 1000, 300000),
    maxInputTokens: integer("ANONYMOUS_MAX_INPUT_TOKENS", 131072, 4096, 131072),
    maxCompletionTokens: integer("ANONYMOUS_MAX_COMPLETION_TOKENS", 4096, 1, 16384),
    // OpenAI list prices for the free model, in USD per million tokens.
    inputPrice: integer("INFERENCE_FREE_INPUT_PRICE_MICRO_USD_PER_MILLION", 250000, 1, 100000000) / 1000000,
    outputPrice: integer("INFERENCE_FREE_OUTPUT_PRICE_MICRO_USD_PER_MILLION", 1200000, 1, 100000000) / 1000000,
    maxBodyBytes: integer("ANONYMOUS_MAX_BODY_BYTES", 262144, 1024, 1048576),
    maxResponseBytes: integer("ANONYMOUS_MAX_RESPONSE_BYTES", 2097152, 16384, 16777216),
    trustProxyHops: integer("ANONYMOUS_TRUST_PROXY_HOPS", 0, 0, 8),
    trustedProxyIps: (environment.ANONYMOUS_TRUSTED_PROXY_IPS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  }
}
export type AutoConfig = ReturnType<typeof readAutoConfig>
type Prices = Pick<AutoConfig, "inputPrice" | "outputPrice">
/** Cost of a completion from OpenAI's token counts, rounded up to the accounting unit. */
export function freeUsageAmount(config: Prices, inputTokens: number, outputTokens: number) {
  return Math.ceil((inputTokens * config.inputPrice + outputTokens * config.outputPrice) * INFERENCE_USAGE_CONVERSION_FACTOR / 1000000)
}
export function freeRequestReservation(config: AutoConfig) {
  return Math.ceil(freeUsageAmount(config, config.maxInputTokens, config.maxCompletionTokens) * 1.1)
}
