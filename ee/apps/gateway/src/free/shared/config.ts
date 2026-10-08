import { readFreeInferenceConfig } from "@openwork/types/den/inference"
import { DESKTOP_FREE_SESSION_POW_BITS, DESKTOP_FREE_SESSION_POW_MAX_BITS, DESKTOP_FREE_SESSION_POW_MAX_ROUNDS, DESKTOP_FREE_SESSION_POW_ROUNDS, parseDesktopVersion } from "@openwork/free-auto"
import { DEFAULT_INSTALL_RAMP, parseInstallRamp } from "@openwork/free-auto/accounting"

export const FREE_OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
export const FREE_OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
const DEFAULT_FREE_OPENAI_MODEL = "gpt-6-luna"

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
  // A machine is worth little until the app has been open for a while: tiers unlock by active minutes,
  // credited from heartbeats no further apart than the activity gap. "activeMinutes:microUsd,…" ascending.
  const installRamp = parseInstallRamp(environment.ANONYMOUS_INSTALL_RAMP?.trim() || DEFAULT_INSTALL_RAMP, deviceWeeklyAmount)
  // One dedicated OpenAI key serves every free request. Revoking it at OpenAI is
  // the kill switch, and its OpenAI usage page is the true cost over time.
  const apiKey = environment.INFERENCE_FREE_OPENAI_API_KEY?.trim() || ""
  const upstreamModel = environment.INFERENCE_FREE_OPENAI_MODEL?.trim() || DEFAULT_FREE_OPENAI_MODEL
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(upstreamModel)) throw new Error("Invalid INFERENCE_FREE_OPENAI_MODEL")
  const tokenSecret = environment.ANONYMOUS_TOKEN_SECRET?.trim() || ""
  const accountingIdentityKey = environment.ANONYMOUS_ACCOUNTING_IDENTITY_KEY?.trim() || ""
  const ready = Boolean(apiKey && accountingIdentityKey.length >= 32)
  // Guests must come from an official desktop build. Each release and alpha derives
  // its own secret from this master key at build time; rotate with a _PREVIOUS overlap.
  const releaseKey = environment.DESKTOP_FREE_RELEASE_KEY?.trim() || ""
  const minimumVersion = environment.DESKTOP_FREE_MIN_VERSION?.trim().replace(/^v/, "") || null
  if (minimumVersion && !parseDesktopVersion(minimumVersion)) throw new Error("Invalid DESKTOP_FREE_MIN_VERSION")
  const releaseKeyPrevious = environment.DESKTOP_FREE_RELEASE_KEY_PREVIOUS?.trim() || ""
  const devMode = environment.OPENWORK_DEV_MODE === "1" && environment.NODE_ENV !== "production"
  const devReleaseSecret = devMode ? environment.DESKTOP_FREE_DEV_RELEASE_SECRET?.trim() || "" : ""
  const distinct = new Set([releaseKey, releaseKeyPrevious, devReleaseSecret, tokenSecret, accountingIdentityKey].filter(Boolean))
  if (distinct.size !== [releaseKey, releaseKeyPrevious, devReleaseSecret, tokenSecret, accountingIdentityKey].filter(Boolean).length) throw new Error("Free Auto secrets must be distinct")
  return {
    member, memberEnabled: member.enabled && ready,
    anonymousEnabled: flag("ANONYMOUS_INFERENCE_ENABLED") && ready && tokenSecret.length >= 32 && tokenSecret !== accountingIdentityKey && releaseKey.length >= 32,
    apiKey, upstreamModel, tokenSecret, accountingIdentityKey,
    releaseKey, releaseKeyPrevious: releaseKeyPrevious.length >= 32 ? releaseKeyPrevious : "",
    devReleaseSecret: devReleaseSecret.length >= 32 ? devReleaseSecret : "",
    /** Free database work one Gateway instance runs at once, and how much more may wait, before new requests get free_auto_busy. */
    maxConcurrent: integer("FREE_AUTO_MAX_CONCURRENT", 8, 1, 200),
    maxQueued: integer("FREE_AUTO_MAX_QUEUED", 32, 0, 1000),
    /** The desktop reports its version like a user agent. Unset, every version may use Auto; blocked versions never may. */
    minimumVersion,
    blockedReleases: (environment.DESKTOP_FREE_BLOCKED_RELEASES ?? "").split(",").map((value) => value.trim().replace(/^v/, "")).filter(Boolean),
    deviceWeeklyAmount, installRamp,
    activityMaxGapMs: integer("ANONYMOUS_ACTIVITY_MAX_GAP_MS", 180000, 1000, 3600000),
    /**
     * Builds without a release tag (built from source, or by anyone) still get Auto, like OpenCode's anonymous free
     * models: their machine id is only self-reported, so each IP gets a small daily budget and all of them together a
     * shared daily cap, on top of the normal device and global windows. 0 for either turns untagged builds off.
     */
    untaggedIpDailyAmount: integer("ANONYMOUS_UNTAGGED_IP_DAILY_MICRO_USD", 200000, 0, 100000000) * 100,
    untaggedGlobalDailyAmount: integer("ANONYMOUS_UNTAGGED_GLOBAL_DAILY_MICRO_USD", 10000000, 0, 1000000000) * 100,
    sessionPowBits: integer("ANONYMOUS_SESSION_POW_BITS", DESKTOP_FREE_SESSION_POW_BITS, 0, DESKTOP_FREE_SESSION_POW_MAX_BITS),
    sessionPowRounds: integer("ANONYMOUS_SESSION_POW_ROUNDS", DESKTOP_FREE_SESSION_POW_ROUNDS, 1, DESKTOP_FREE_SESSION_POW_MAX_ROUNDS),
    globalDailyAmount: integer("ANONYMOUS_GLOBAL_DAILY_MICRO_USD", 100000000, 1, 1000000000) * 100,
    globalMonthlyAmount: integer("ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD", 3000000000, 1, 10000000000) * 100,
    tokenTtlSeconds: integer("ANONYMOUS_TOKEN_TTL_SECONDS", 3600, 60, 86400),
    /** How long OpenAI may take to start answering, like paid Models' upstream timeout. A started answer is never cut off. */
    requestTimeoutMs: integer("ANONYMOUS_REQUEST_TIMEOUT_MS", 60000, 1000, 300000),
    /** Charged when OpenAI never reports a request's usage (the stream broke or the client left); OpenAI has no usage webhook. */
    unreportedUsageAmount: integer("INFERENCE_FREE_UNREPORTED_USAGE_MICRO_USD", 40000, 0, 10000000) * 100,
    // OpenAI list prices for the free model, in USD per million tokens.
    inputPrice: integer("INFERENCE_FREE_INPUT_PRICE_MICRO_USD_PER_MILLION", 100000, 1, 100000000) / 1000000,
    cachedInputPrice: integer("INFERENCE_FREE_CACHED_INPUT_PRICE_MICRO_USD_PER_MILLION", 10000, 0, 100000000) / 1000000,
    outputPrice: integer("INFERENCE_FREE_OUTPUT_PRICE_MICRO_USD_PER_MILLION", 500000, 1, 100000000) / 1000000,
    // Match the paid Gateway body ceiling; free requests do not get a smaller context limit.
    maxBodyBytes: integer("ANONYMOUS_MAX_BODY_BYTES", 32 * 1024 * 1024, 1024, 32 * 1024 * 1024),
    /** The largest single response frame the meter buffers; the answer as a whole is not capped. */
    maxResponseBytes: integer("ANONYMOUS_MAX_RESPONSE_BYTES", 2097152, 16384, 16777216),
    trustProxyHops: integer("ANONYMOUS_TRUST_PROXY_HOPS", 0, 0, 8),
    trustedProxyIps: (environment.ANONYMOUS_TRUSTED_PROXY_IPS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
  }
}
export type AutoConfig = ReturnType<typeof readAutoConfig>
/** Untagged builds may use guest Auto only while both of their budgets are on. */
export function untaggedAutoEnabled(config: Pick<AutoConfig, "untaggedIpDailyAmount" | "untaggedGlobalDailyAmount">) {
  return config.untaggedIpDailyAmount > 0 && config.untaggedGlobalDailyAmount > 0
}
