/**
 * Provider checks for Settings › Diagnostics.
 *
 * Stored facts first (credential present, expired, refused, configuration
 * errors), then, only on a live check, one read-only request per org-held
 * credential that lists models or confirms the key (AWS STS). Never a model
 * completion, never a member's credential, never an upstream body or URL in
 * the result. Probes are bounded (8 s each, at most 4 at a time) and go through
 * the inference egress guard.
 */
import type { ProviderCheck, ProviderCheckReason, ProviderCheckState } from "@openwork/types/den/diagnostics"
import { parseGatewayProviderSecret, type GatewayProviderCredentialKind, type GatewayProviderCredentialStatus, type GatewayProviderSecret } from "@openwork/types/den/gateway"
import { readProviderEnvNames, selectPrimaryCredentialEnvName } from "@openwork/types/managed-provider-config"
import { AwsSsoError, getAwsCallerIdentity } from "@openwork-ee/utils/aws-identity-center"
import type { AwsCredentials } from "@openwork-ee/utils/aws-sigv4"
import { isInferenceCredentialKindSupported, pickInferenceApiKeyFromMap } from "@openwork-ee/utils/inference-credentials"
import { InferenceEgressError, isAwsRegion, validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import { LITELLM_ADMIN_CREDENTIAL_SUBJECT, isLiteLlmProviderId } from "@openwork-ee/utils/litellm-catalog"
import { MICROSOFT_FOUNDRY_PROVIDER_ID } from "@openwork-ee/utils/microsoft-foundry-catalog"
import { gatewayUpstreamDestination } from "../credential-prompt.js"
import { detectVendor, probeEndpoint } from "../llm/endpoint-probe.js"
import { gatewayConfigurationError, readProviderConfigNpm } from "../llm/inference-provider-config.js"
import { LiteLlmError, createLiteLlmClient, normalizeLiteLlmBaseUrl } from "../llm/litellm.js"
import { readLiteLlmSettings } from "../llm/litellm-settings.js"
import { decodeProviderCredential } from "../llm/provider-credentials.js"

type JsonRecord = Record<string, unknown>

export const PROVIDER_PROBE_TIMEOUT_MS = 8_000
export const PROVIDER_PROBE_CONCURRENCY = 4
const MAX_LISTING_BYTES = 4 * 1024 * 1024
const MAX_MISSING_MODELS = 20

/** What a live check calls. Holds a credential: kept in memory for one check only, never cached or returned. */
export type ProbeSpec =
  | { kind: "litellm"; baseUrl: string; apiKey: string }
  | { kind: "openai"; baseUrl: string; apiKey: string }
  | { kind: "anthropic"; baseUrl: string; apiKey: string }
  | { kind: "google"; baseUrl: string; apiKey: string }
  | { kind: "aws_sts"; region: string; credentials: AwsCredentials }

type Verdict = { state: ProviderCheckState; reason: ProviderCheckReason }

export type ProviderTarget = {
  id: string
  source: ProviderCheck["source"]
  providerId: string
  name: string
  credentialName: string | null
  /** The row when no live result applies: a stored fact, or not checked yet. */
  fallback: Verdict
  /** Live check; null when stored facts decide the row. */
  probe: ProbeSpec | null
  /** Changes when the provider or its credential changes; cached live results apply only to the same version. */
  version: string
  configuredModels: string[]
  /** Compare configured with listed models (off for Azure deployments and per-person keys). */
  compareModels: boolean
  /** State when the live check accepts the key and no model comparison applies (per-person LiteLLM keeps member_credentials). */
  accepted: Verdict | null
  /** How a refused egress destination reads: Gateway providers are misconfigured; desktop-reached endpoints are simply not checked. */
  egressRefusal: Verdict
  members: ProviderCheck["members"]
}

export type ProbeOutcome = Verdict & {
  httpStatus: number | null
  durationMs: number
  /** Model ids the endpoint listed, or null when it does not list models (or failed). */
  served: string[] | null
}

const NOT_CHECKED_YET: Verdict = { state: "not_checked", reason: "not_checked_yet" }
const NO_LIVE_CHECK: Verdict = { state: "not_checked", reason: "no_live_check" }
const MEMBER_SIGN_IN: Verdict = { state: "member_credentials", reason: "member_sign_in" }
const CONFIGURATION_ERROR: Verdict = { state: "misconfigured", reason: "configuration_error" }
const CREDENTIAL_MISSING: Verdict = { state: "misconfigured", reason: "credential_missing" }
const CREDENTIAL_REJECTED: Verdict = { state: "key_rejected", reason: "credential_rejected" }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(record: unknown, ...path: string[]): string | null {
  let value = record
  for (const key of path) {
    if (!isRecord(value)) return null
    value = value[key]
  }
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

// ── Gateway providers ─────────────────────────────────────────────────────

export type GatewayProviderInput = {
  id: string
  provider_id: string
  name: string
  model_ids: string[]
  provider_config: JsonRecord
  settings: JsonRecord
  status: string
  updated_at: Date
}
export type GatewaySetInput = { id: string; gateway_provider_id: string; name: string; credential_mode: "org" | "member"; status: string }
export type GatewayCredentialInput = {
  gateway_provider_id: string
  credential_set_id: string
  subject: string
  org_membership_id: string | null
  kind: GatewayProviderCredentialKind
  status: GatewayProviderCredentialStatus
  expires_at: Date | null
  last_error: string | null
  updated_at: Date
  /** Org-held credentials only; member credentials are never read. */
  secret: string | null
}
export type GatewayModelInput = { gateway_provider_id: string; model_id: string }

type GatewayFamily = "openai" | "anthropic" | "google" | "bedrock" | "none"

const FAMILY_BY_NPM: Record<string, GatewayFamily> = {
  "@ai-sdk/openai": "openai",
  "@ai-sdk/openai-compatible": "openai",
  "@ai-sdk/mistral": "openai",
  "@ai-sdk/azure": "openai",
  "@openrouter/ai-sdk-provider": "openai",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
  "@ai-sdk/amazon-bedrock": "bedrock",
  "@ai-sdk/amazon-bedrock/mantle": "none",
  "@ai-sdk/google-vertex": "none",
  "@ai-sdk/google-vertex/anthropic": "none",
}

function gatewayFamily(provider: GatewayProviderInput): GatewayFamily {
  // Claude on Microsoft Foundry uses the Anthropic SDK against an Entra-authenticated host.
  if (provider.provider_id === MICROSOFT_FOUNDRY_PROVIDER_ID) return "none"
  const npm = readProviderConfigNpm(provider.provider_config)
  if (npm && Object.hasOwn(FAMILY_BY_NPM, npm)) return FAMILY_BY_NPM[npm]
  // The gateway forwards an unknown SDK with a known API base as OpenAI-compatible.
  return readString(provider.provider_config, "api") ? "openai" : "none"
}

function memberCounts(credentials: readonly GatewayCredentialInput[], now: number): NonNullable<ProviderCheck["members"]> {
  const connected = new Set<string>()
  const attention = new Set<string>()
  for (const credential of credentials) {
    if (!credential.org_membership_id || credential.status === "revoked") continue
    const oauth = credential.kind === "oauth_google" || credential.kind === "oauth_azure" || credential.kind === "aws_sso"
    // OAuth access tokens expire hourly and refresh on use; only a failed refresh needs the person.
    const expired = !oauth && credential.expires_at !== null && credential.expires_at.getTime() <= now
    if (credential.status === "refresh_failed" || credential.last_error === "invalid_client" || expired) attention.add(credential.org_membership_id)
    else connected.add(credential.org_membership_id)
  }
  for (const memberId of attention) connected.delete(memberId)
  return { connected: connected.size, needsAttention: attention.size }
}

function apiKeyFromSecret(secret: GatewayProviderSecret, providerConfig: JsonRecord): string | null {
  if (secret.kind === "api_key") return secret.apiKey || null
  if (secret.kind === "api_key_map") return pickInferenceApiKeyFromMap(secret.apiKeys, readProviderEnvNames(providerConfig))
  return null
}

function validBase(base: string | null): string | null {
  if (!base) return null
  try {
    validateInferenceUrl(base, { base: true })
    return base.replace(/\/+$/, "")
  } catch {
    return null
  }
}

/** Stored facts of one org-held credential, or the probe it allows. */
function orgCredentialVerdict(provider: GatewayProviderInput, credential: GatewayCredentialInput | undefined, now: number): Verdict | { probe: ProbeSpec | null; compareModels: boolean } {
  if (!credential || credential.status === "revoked" || !credential.secret) return CREDENTIAL_MISSING
  if (credential.status === "refresh_failed" || credential.last_error === "invalid_client") return CREDENTIAL_REJECTED
  let secret: GatewayProviderSecret
  try {
    secret = parseGatewayProviderSecret(credential.kind, credential.secret)
  } catch {
    return CONFIGURATION_ERROR
  }
  if (!isInferenceCredentialKindSupported(secret.kind, provider.provider_id)) return CONFIGURATION_ERROR
  if (credential.expires_at !== null && credential.expires_at.getTime() <= now && secret.kind !== "oauth_google") {
    return { state: "key_rejected", reason: "credential_expired" }
  }
  const family = gatewayFamily(provider)
  if (family === "none") return { probe: null, compareModels: false }
  if (family === "bedrock") {
    if (secret.kind !== "aws_keys") return { probe: null, compareModels: false }
    const region = secret.awsKeys.region ?? provider.settings.region
    if (!isAwsRegion(region)) return CONFIGURATION_ERROR
    const { accessKeyId, secretAccessKey, sessionToken } = secret.awsKeys
    return { probe: { kind: "aws_sts", region, credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } }, compareModels: false }
  }
  const apiKey = apiKeyFromSecret(secret, provider.provider_config)
  if (!apiKey) return CREDENTIAL_MISSING
  const baseUrl = validBase(gatewayUpstreamDestination(provider.provider_id, provider.provider_config, provider.settings))
  if (!baseUrl) return CONFIGURATION_ERROR
  const azure = readProviderConfigNpm(provider.provider_config) === "@ai-sdk/azure" || detectVendor(baseUrl) === "azure"
  return { probe: { kind: family, baseUrl, apiKey }, compareModels: !azure }
}

function liteLlmTarget(
  provider: GatewayProviderInput,
  sets: readonly GatewaySetInput[],
  credentials: readonly GatewayCredentialInput[],
  configuredModels: string[],
  now: number,
): ProviderTarget {
  const base = {
    id: provider.id, source: "gateway" as const, providerId: provider.provider_id, name: provider.name, credentialName: null,
    configuredModels, egressRefusal: CONFIGURATION_ERROR,
  }
  const settings = readLiteLlmSettings(provider.settings)
  if (!settings) {
    return { ...base, fallback: CONFIGURATION_ERROR, probe: null, version: `${provider.updated_at.getTime()}`, compareModels: false, accepted: null, members: null }
  }
  const member = settings.mode === "member"
  const set = sets.find((entry) => entry.id === settings.credentialSetId)
  const subject = member ? LITELLM_ADMIN_CREDENTIAL_SUBJECT : "org"
  const credential = set ? credentials.find((entry) => entry.credential_set_id === set.id && entry.subject === subject && entry.org_membership_id === null) : undefined
  const members = member ? memberCounts(credentials, now) : null
  const version = `${provider.updated_at.getTime()}:${credential?.updated_at.getTime() ?? 0}`
  const stored: Verdict = settings.lastSyncError ? { state: "misconfigured", reason: "sync_error" } : member ? MEMBER_SIGN_IN : NOT_CHECKED_YET
  const shared = { ...base, version, members, compareModels: !member, accepted: member ? MEMBER_SIGN_IN : null }
  const upstream = typeof provider.settings.upstreamBaseUrl === "string" ? provider.settings.upstreamBaseUrl : null
  let baseUrl: string | null = null
  try { baseUrl = upstream ? normalizeLiteLlmBaseUrl(upstream).adminBaseUrl : null } catch { baseUrl = null }
  if (!set || !baseUrl) return { ...shared, fallback: CONFIGURATION_ERROR, probe: null }
  const expired = credential?.expires_at ? credential.expires_at.getTime() <= now : false
  const usable = credential && credential.status === "active" && credential.kind === "api_key" && credential.secret?.trim() && !expired
  if (!credential || !usable || !credential.secret) {
    const refused: Verdict = credential?.status === "refresh_failed" ? CREDENTIAL_REJECTED
      : expired && credential?.status === "active" ? { state: "key_rejected", reason: "credential_expired" } : CREDENTIAL_MISSING
    // Without the admin key a per-person provider still serves connected people; the org key is required.
    return { ...shared, fallback: member ? stored : refused, probe: null }
  }
  return { ...shared, fallback: stored, probe: { kind: "litellm", baseUrl, apiKey: credential.secret.trim() } }
}

/** One row per active org-mode or member-mode credential set (LiteLLM: one row per provider). */
export function buildGatewayProviderTargets(input: {
  providers: readonly GatewayProviderInput[]
  sets: readonly GatewaySetInput[]
  credentials: readonly GatewayCredentialInput[]
  models: readonly GatewayModelInput[]
  now: number
}): ProviderTarget[] {
  const targets: ProviderTarget[] = []
  for (const provider of input.providers) {
    if (provider.status !== "active") continue
    const policy = new Set(provider.model_ids)
    const configuredModels = uniqueSorted(input.models
      .filter((model) => model.gateway_provider_id === provider.id && (policy.size === 0 || policy.has(model.model_id)))
      .map((model) => model.model_id))
    const sets = input.sets.filter((set) => set.gateway_provider_id === provider.id && set.status === "active")
    const credentials = input.credentials.filter((credential) => credential.gateway_provider_id === provider.id)
    if (isLiteLlmProviderId(provider.provider_id)) {
      targets.push(liteLlmTarget(provider, sets, credentials, configuredModels, input.now))
      continue
    }
    const configurationError = gatewayConfigurationError(provider.provider_config, provider.settings)
    for (const set of sets) {
      const setCredentials = credentials.filter((credential) => credential.credential_set_id === set.id)
      const common = {
        id: `${provider.id}:${set.id}`, source: "gateway" as const, providerId: provider.provider_id, name: provider.name,
        credentialName: sets.length > 1 ? set.name : null, configuredModels, egressRefusal: CONFIGURATION_ERROR, accepted: null,
      }
      if (set.credential_mode === "member") {
        targets.push({ ...common, fallback: MEMBER_SIGN_IN, probe: null, version: `${provider.updated_at.getTime()}`, compareModels: false, members: memberCounts(setCredentials, input.now) })
        continue
      }
      const credential = setCredentials.find((entry) => entry.subject === "org" && entry.org_membership_id === null)
      const version = `${provider.updated_at.getTime()}:${credential?.updated_at.getTime() ?? 0}`
      if (configurationError) {
        targets.push({ ...common, fallback: CONFIGURATION_ERROR, probe: null, version, compareModels: false, members: null })
        continue
      }
      const verdict = orgCredentialVerdict(provider, credential, input.now)
      if ("state" in verdict) {
        targets.push({ ...common, fallback: verdict, probe: null, version, compareModels: false, members: null })
        continue
      }
      targets.push({
        ...common, version, members: null, probe: verdict.probe, compareModels: verdict.compareModels,
        fallback: verdict.probe ? NOT_CHECKED_YET : NO_LIVE_CHECK,
      })
    }
  }
  return targets
}

// ── Legacy (desktop-delivered) providers ──────────────────────────────────

export type LegacyProviderInput = {
  id: string
  source: "models_dev" | "custom" | "openwork"
  providerId: string
  name: string
  providerConfig: JsonRecord
  credentialMode: "shared" | "per_member"
  apiKey: string | null
  updatedAt: Date
}
export type LegacyMemberCredentialInput = { llmProviderId: string; orgMembershipId: string; state: "active" | "blocked" | "stale" | "error" }
export type LegacyModelInput = { llmProviderId: string; modelId: string }

function legacyApiKey(provider: LegacyProviderInput): string | null {
  const decoded = decodeProviderCredential(provider.apiKey)
  if (decoded.apiKey) return decoded.apiKey
  if (!decoded.apiKeys) return null
  const name = selectPrimaryCredentialEnvName(readProviderEnvNames(provider.providerConfig), Object.keys(decoded.apiKeys))
  return name ? decoded.apiKeys[name] ?? null : null
}

export function buildLegacyProviderTargets(input: {
  providers: readonly LegacyProviderInput[]
  memberCredentials: readonly LegacyMemberCredentialInput[]
  models: readonly LegacyModelInput[]
}): ProviderTarget[] {
  const targets: ProviderTarget[] = []
  for (const provider of input.providers) {
    // The OpenWork provider row is summarized by the OpenWork Models row.
    if (provider.source === "openwork") continue
    const common = {
      id: provider.id, source: "legacy" as const, providerId: provider.providerId, name: provider.name, credentialName: null,
      version: `${provider.updatedAt.getTime()}`, accepted: null, egressRefusal: NO_LIVE_CHECK,
      configuredModels: uniqueSorted(input.models.filter((model) => model.llmProviderId === provider.id).map((model) => model.modelId)),
    }
    if (provider.credentialMode === "per_member") {
      const rows = input.memberCredentials.filter((row) => row.llmProviderId === provider.id)
      const attention = new Set(rows.filter((row) => row.state === "stale" || row.state === "error").map((row) => row.orgMembershipId))
      const connected = new Set(rows.filter((row) => row.state === "active" && !attention.has(row.orgMembershipId)).map((row) => row.orgMembershipId))
      targets.push({ ...common, fallback: MEMBER_SIGN_IN, probe: null, compareModels: false, members: { connected: connected.size, needsAttention: attention.size } })
      continue
    }
    if (provider.source !== "custom") {
      targets.push({ ...common, fallback: NO_LIVE_CHECK, probe: null, compareModels: false, members: null })
      continue
    }
    const configured = readString(provider.providerConfig, "options", "baseURL") ?? readString(provider.providerConfig, "api")
    if (!configured) {
      targets.push({ ...common, fallback: CONFIGURATION_ERROR, probe: null, compareModels: false, members: null })
      continue
    }
    const apiKey = legacyApiKey(provider)
    // Den may not be able to reach an endpoint only the desktop app uses (e.g. a private network).
    const baseUrl = validBase(configured)
    if (!apiKey || !baseUrl) {
      targets.push({ ...common, fallback: apiKey ? NO_LIVE_CHECK : { state: "not_checked", reason: "credential_missing" }, probe: null, compareModels: false, members: null })
      continue
    }
    targets.push({
      ...common, fallback: NOT_CHECKED_YET, probe: { kind: "openai", baseUrl, apiKey },
      compareModels: detectVendor(baseUrl) !== "azure", members: null,
    })
  }
  return targets
}

export function openWorkModelsTarget(): ProviderTarget {
  return {
    id: "openwork", source: "openwork", providerId: "openwork", name: "OpenWork Models", credentialName: null,
    fallback: { state: "managed", reason: "managed_by_openwork" }, probe: null, version: "openwork",
    configuredModels: [], compareModels: false, accepted: null, egressRefusal: NO_LIVE_CHECK, members: null,
  }
}

// ── Live probes ───────────────────────────────────────────────────────────

export type ProbeDeps = {
  fetchImpl: typeof fetch
  timeoutMs?: number
  now?: () => number
}

type ProbeFailure = { error: unknown }

function statusVerdict(status: number, kind: ProbeSpec["kind"]): Verdict {
  // Google AI Studio answers an invalid API key with 400 API_KEY_INVALID.
  if (status === 401 || status === 403 || (kind === "google" && status === 400)) return CREDENTIAL_REJECTED
  if (status === 404) return { state: "misconfigured", reason: "endpoint_not_found" }
  return { state: "unreachable", reason: "unexpected_response" }
}

function errorVerdict(error: unknown, timedOut: boolean, egressRefusal: Verdict): Verdict {
  if (timedOut) return { state: "unreachable", reason: "timeout" }
  if (error instanceof InferenceEgressError) return egressRefusal
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { state: "unreachable", reason: "timeout" }
  return { state: "unreachable", reason: "network_error" }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length > MAX_LISTING_BYTES) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function anthropicModelsUrl(baseUrl: string) {
  return /\/v1$/i.test(new URL(baseUrl).pathname) ? `${baseUrl}/models?limit=1000` : `${baseUrl}/v1/models?limit=1000`
}

function googleModelsUrl(baseUrl: string) {
  return /\/v1(?:beta|alpha)?$/i.test(new URL(baseUrl).pathname) ? `${baseUrl}/models?pageSize=1000` : `${baseUrl}/v1beta/models?pageSize=1000`
}

async function listWithHeaders(fetchImpl: typeof fetch, kind: "anthropic" | "google", url: string, headers: Record<string, string>): Promise<{ status: number; served: string[] | null }> {
  validateInferenceUrl(url)
  const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "error" })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { status: response.status, served: null }
  }
  const body = await readBoundedJson(response)
  if (kind === "anthropic") {
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : null
    return { status: response.status, served: data ? uniqueSorted(data.flatMap((entry) => { const id = readString(entry, "id"); return id ? [id] : [] })) : null }
  }
  const models = isRecord(body) && Array.isArray(body.models) ? body.models : null
  return {
    status: response.status,
    served: models ? uniqueSorted(models.flatMap((entry) => {
      const name = readString(entry, "name")
      return name ? [name.replace(/^models\//, "")] : []
    })) : null,
  }
}

/** One bounded, read-only check. Never throws. */
export async function runProviderProbe(probe: ProbeSpec, egressRefusal: Verdict, deps: ProbeDeps): Promise<ProbeOutcome> {
  const now = deps.now ?? Date.now
  const started = now()
  const controller = new AbortController()
  const timeoutMs = deps.timeoutMs ?? PROVIDER_PROBE_TIMEOUT_MS
  const failure: ProbeFailure = { error: null }
  const fetchImpl: typeof fetch = async (input, init) => {
    const signal = init?.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal
    try {
      return await deps.fetchImpl(input, { ...init, signal })
    } catch (error) {
      failure.error = error
      throw error
    }
  }
  const finish = (verdict: Verdict, httpStatus: number | null, served: string[] | null): ProbeOutcome => ({
    ...verdict, httpStatus, served, durationMs: Math.max(0, Math.round(now() - started)),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve("timeout")
    }, timeoutMs)
  })
  const work = (async (): Promise<ProbeOutcome> => {
    try {
      switch (probe.kind) {
        case "openai": {
          const result = await probeEndpoint({ api: probe.baseUrl, apiKey: probe.apiKey, fetchImpl })
          if (result.ok) return finish({ state: "ready", reason: "models_listed" }, result.status, uniqueSorted(result.models.map((model) => model.id)))
          if (result.status !== null) return finish(statusVerdict(result.status, probe.kind), result.status, null)
          if (failure.error) return finish(errorVerdict(failure.error, controller.signal.aborted, egressRefusal), null, null)
          return finish(egressRefusal, null, null)
        }
        case "anthropic":
        case "google": {
          const url = probe.kind === "anthropic" ? anthropicModelsUrl(probe.baseUrl) : googleModelsUrl(probe.baseUrl)
          const headers: Record<string, string> = probe.kind === "anthropic"
            ? { "x-api-key": probe.apiKey, "anthropic-version": "2023-06-01" }
            : { "x-goog-api-key": probe.apiKey }
          const result = await listWithHeaders(fetchImpl, probe.kind, url, headers)
          if (result.status >= 200 && result.status < 300 && result.served) return finish({ state: "ready", reason: "models_listed" }, result.status, result.served)
          if (result.status >= 200 && result.status < 300) return finish({ state: "unreachable", reason: "unexpected_response" }, result.status, null)
          return finish(statusVerdict(result.status, probe.kind), result.status, null)
        }
        case "litellm": {
          const client = createLiteLlmClient(normalizeLiteLlmBaseUrl(probe.baseUrl), fetchImpl)
          const served = await client.listModels(probe.apiKey)
          return finish({ state: "ready", reason: "models_listed" }, 200, served)
        }
        case "aws_sts": {
          await getAwsCallerIdentity({ region: probe.region, credentials: probe.credentials, fetchImpl, signal: controller.signal })
          return finish({ state: "ready", reason: "key_accepted" }, 200, null)
        }
      }
    } catch (error) {
      if (error instanceof LiteLlmError) {
        if (error.code === "invalid_base_url") return finish(CONFIGURATION_ERROR, null, null)
        if (error.code === "unreachable") return finish(errorVerdict(failure.error, controller.signal.aborted, egressRefusal), null, null)
        if (error.status !== null) return finish(statusVerdict(error.status, probe.kind), error.status, null)
        return finish({ state: "unreachable", reason: "unexpected_response" }, null, null)
      }
      if (error instanceof AwsSsoError) {
        if (error.code === "aws_sso_unreachable") return finish(errorVerdict(failure.error, controller.signal.aborted, egressRefusal), null, null)
        if (error.code === "aws_sso_role_forbidden") return finish(CREDENTIAL_REJECTED, error.status ?? null, null)
        if (error.code === "aws_sso_invalid_request") return finish(CONFIGURATION_ERROR, error.status ?? null, null)
        return finish({ state: "unreachable", reason: "unexpected_response" }, error.status ?? null, null)
      }
      return finish(errorVerdict(failure.error ?? error, controller.signal.aborted, egressRefusal), null, null)
    }
  })()
  try {
    const result = await Promise.race([work, timedOut])
    return result === "timeout" ? finish({ state: "unreachable", reason: "timeout" }, null, null) : result
  } finally {
    clearTimeout(timer)
  }
}

// ── Results ───────────────────────────────────────────────────────────────

export type EvaluatedProvider = {
  /** Present only when a live check could run for this row. */
  probed: boolean
  version: string
  check: ProviderCheck
}

const SUCCESS_STATES: ReadonlySet<ProviderCheckState> = new Set(["ready", "model_missing", "member_credentials"])

/** The row for a target and its live outcome (null: no live result applies). */
export function providerCheckFromOutcome(target: ProviderTarget, outcome: ProbeOutcome | null, checkedAt: string, previousSuccessAt: string | null): ProviderCheck {
  const base = {
    id: target.id, source: target.source,
    // Stored names are bounded by their columns; keep the contract's bounds even for odd rows.
    providerId: target.providerId.slice(0, 128) || "unknown",
    name: target.name.trim().slice(0, 255) || target.providerId.slice(0, 255) || "Provider",
    credentialName: target.credentialName?.slice(0, 255) ?? null,
    members: target.members,
  }
  if (!outcome) {
    const verdict = target.fallback
    return {
      ...base, ...verdict, httpStatus: null, durationMs: null,
      checkedAt: verdict.state === "not_checked" ? null : checkedAt,
      lastSuccessAt: previousSuccessAt,
      models: { configured: target.configuredModels.length, served: null, missing: [] },
    }
  }
  let verdict: Verdict = { state: outcome.state, reason: outcome.reason }
  let missing: string[] = []
  if (outcome.state === "ready") {
    const served = outcome.served
    if (target.compareModels && served && served.length > 0) {
      const available = new Set(served)
      missing = target.configuredModels.filter((model) => !available.has(model))
      if (missing.length) verdict = { state: "model_missing", reason: "models_listed" }
    } else if (target.accepted) {
      verdict = target.accepted
    }
  }
  return {
    ...base, ...verdict,
    httpStatus: outcome.httpStatus,
    durationMs: outcome.durationMs,
    checkedAt,
    lastSuccessAt: SUCCESS_STATES.has(verdict.state) ? checkedAt : previousSuccessAt,
    models: {
      configured: target.configuredModels.length,
      served: outcome.served ? outcome.served.length : null,
      missing: missing.slice(0, MAX_MISSING_MODELS),
    },
  }
}

export async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index])
    }
  }))
  return results
}

/**
 * Rows for every target. With `live`, probes the targets that allow it (at
 * most PROVIDER_PROBE_CONCURRENCY at a time); otherwise stored facts only.
 */
export async function evaluateProviderTargets(
  targets: readonly ProviderTarget[],
  options: { live: boolean; deps: ProbeDeps; previousSuccess?: ReadonlyMap<string, string> },
): Promise<EvaluatedProvider[]> {
  const now = options.deps.now ?? Date.now
  return mapLimited(targets, PROVIDER_PROBE_CONCURRENCY, async (target) => {
    const previous = options.previousSuccess?.get(target.id) ?? null
    const outcome = options.live && target.probe ? await runProviderProbe(target.probe, target.egressRefusal, options.deps) : null
    return {
      probed: target.probe !== null,
      version: target.version,
      check: providerCheckFromOutcome(target, outcome, new Date(now()).toISOString(), previous),
    }
  })
}
