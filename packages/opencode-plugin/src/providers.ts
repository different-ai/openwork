/**
 * OpenWork AI Gateway providers → OpenCode V2 providers.
 *
 * Den returns, per gateway provider (`ipr_*`), an OpenCode V1-shaped provider
 * block (`providerConfig`) and a models.dev-shaped catalog config per model
 * (`models[].config`, ids `gwm_*`). The desktop materializes these as V1
 * config (apps/server/src/cloud-provider-sync.ts). Here they become V2
 * `Provider.Info` + `Model.Info`, following how OpenCode V2 itself ingests
 * models.dev entries (packages/core/src/models-dev.ts modelInfo/nativePackage)
 * and V1 config (packages/core/src/v1/config/migrate.ts).
 */
import { DenRequestError, denRequest, isRecord, type DenSession, type Fetch } from "./den.ts"
import type { ModelCost, ModelInfo, ModelVariant, ProviderInfo } from "./opencode.ts"

type JsonRecord = Record<string, unknown>

export interface GatewayModel {
  readonly id: string
  readonly name: string
  readonly config: JsonRecord
  readonly upstreamModelId: string | null
  readonly modelGroupName: string | null
  readonly credentialSetName: string | null
}

export interface GatewayProvider {
  readonly id: string
  readonly providerId: string
  readonly name: string
  readonly credentialStatus: string
  readonly providerConfig: JsonRecord
  readonly models: readonly GatewayModel[]
}

export interface SkippedProvider {
  readonly id: string
  readonly name: string
  readonly reason: "member_auth_required" | "org_credential_missing" | "no_accessible_models" | "missing_credentials"
}

export interface GatewayInventory {
  readonly providers: readonly GatewayProvider[]
  /** The member's `ow_gw_` key; one per member per organization, the same for every provider. */
  readonly apiKey: string | null
  readonly skipped: readonly SkippedProvider[]
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseModel(value: unknown): GatewayModel | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const name = readString(value.name)
  if (!id || !name || !isRecord(value.config)) return null
  return {
    id,
    name,
    config: value.config,
    upstreamModelId: readString(value.upstreamModelId),
    modelGroupName: readString(value.modelGroupName),
    credentialSetName: readString(value.credentialSetName),
  }
}

export function parseGatewayProvider(value: unknown): GatewayProvider | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const providerId = readString(value.providerId)
  const name = readString(value.name)
  if (!id || !/^ipr_/.test(id) || !providerId || !name || !Array.isArray(value.models)) return null
  const models: GatewayModel[] = []
  for (const entry of value.models) {
    const model = parseModel(entry)
    if (model) models.push(model)
  }
  return {
    id,
    providerId,
    name,
    credentialStatus: readString(value.credentialStatus) ?? "ready",
    providerConfig: isRecord(value.providerConfig) ? value.providerConfig : {},
    models,
  }
}

/**
 * The same two calls the desktop makes: the usable list, then `connect` per
 * provider with models (which carries the member's gateway key).
 */
export async function fetchGatewayInventory(fetcher: Fetch, session: DenSession): Promise<GatewayInventory> {
  let listed: unknown
  try {
    listed = await denRequest(fetcher, session, "/v1/inference-providers?scope=usable")
  } catch (error) {
    // Deployments without the AI Gateway answer 404/405/501: no gateway providers.
    if (error instanceof DenRequestError && [404, 405, 501].includes(error.status)) {
      return { providers: [], apiKey: null, skipped: [] }
    }
    throw error
  }
  const rows = isRecord(listed) && Array.isArray(listed.inferenceProviders) ? listed.inferenceProviders : []
  const providers: GatewayProvider[] = []
  const skipped: SkippedProvider[] = []
  let apiKey: string | null = null
  for (const row of rows) {
    const provider = parseGatewayProvider(row)
    if (!provider) continue
    if (provider.models.length === 0) {
      skipped.push({
        id: provider.id,
        name: provider.name,
        reason: provider.credentialStatus === "member_auth_required" || provider.credentialStatus === "org_credential_missing"
          ? provider.credentialStatus
          : "no_accessible_models",
      })
      continue
    }
    const connected = await denRequest(fetcher, session, `/v1/inference-providers/${encodeURIComponent(provider.id)}/connect`)
    const detail = isRecord(connected) ? connected.inferenceProvider : null
    const key = isRecord(detail) ? readString(detail.apiKey) : null
    const parsed = parseGatewayProvider(detail) ?? provider
    if (!key || !key.startsWith("ow_gw_") || parsed.id !== provider.id) {
      skipped.push({ id: provider.id, name: provider.name, reason: "missing_credentials" })
      continue
    }
    apiKey = key
    providers.push(parsed)
  }
  providers.sort((left, right) => left.id.localeCompare(right.id))
  return { providers, apiKey, skipped }
}

// ---- V1 / models.dev → V2 ----

/** AI SDK package → native OpenCode V2 package (packages/core/src/aisdk-native.ts PACKAGES). */
const NATIVE_PACKAGES: Readonly<Record<string, string>> = {
  "@ai-sdk/amazon-bedrock": "@opencode/ai/providers/amazon-bedrock",
  "@ai-sdk/anthropic": "@opencode/ai/providers/anthropic",
  "@ai-sdk/azure": "@opencode/ai/providers/azure/responses",
  "@ai-sdk/google": "@opencode/ai/providers/google",
  "@ai-sdk/google-vertex": "@opencode/ai/providers/google-vertex",
  "@ai-sdk/google-vertex/anthropic": "@opencode/ai/providers/google-vertex/messages",
  "@ai-sdk/mistral": "@opencode/ai/providers/mistral",
  "@ai-sdk/openai": "@opencode/ai/providers/openai",
  "@ai-sdk/openai-compatible": "@opencode/ai/providers/openai-compatible",
  "@ai-sdk/xai": "@opencode/ai/providers/xai",
  "@openrouter/ai-sdk-provider": "@opencode/ai/providers/openrouter",
}

/** Native package when OpenCode bundles one; otherwise the AI SDK package, loaded by OpenCode. */
export function providerPackage(npm: string | null): string {
  if (!npm) return "@opencode/ai/providers/openai-compatible"
  return NATIVE_PACKAGES[npm] ?? `aisdk:${npm}`
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return entries.length ? Object.fromEntries(entries) : undefined
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function int(value: unknown, fallback: number): number {
  return Math.max(0, Math.trunc(finite(value, fallback)))
}

function costs(value: unknown): ModelCost[] {
  if (!isRecord(value)) return []
  const base: ModelCost = {
    input: finite(value.input, 0),
    output: finite(value.output, 0),
    cache: { read: finite(value.cache_read, 0), write: finite(value.cache_write, 0) },
  }
  const result = [base]
  const over = value.context_over_200k
  if (isRecord(over)) {
    result.push({
      tier: { type: "context", size: 200_000 },
      input: finite(over.input, base.input),
      output: finite(over.output, base.output),
      cache: { read: finite(over.cache_read, base.cache.read), write: finite(over.cache_write, base.cache.write) },
    })
  }
  return result
}

function stringList(value: unknown, fallback: readonly string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [...fallback]
}

function reasoningEfforts(config: JsonRecord): string[] {
  const options = Array.isArray(config.reasoning_options) ? config.reasoning_options : []
  const values = options.flatMap((option) =>
    isRecord(option) && option.type === "effort" && Array.isArray(option.values)
      ? option.values.filter((value): value is string => typeof value === "string" && value !== "null")
      : [],
  )
  return [...new Set(values)]
}

/** Claude generations that only take a manual thinking budget (packages/core/src/variant.ts claudeInfo). */
function manualClaude(upstreamModelId: string | null): boolean {
  const id = upstreamModelId ?? ""
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/i.exec(id)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku)/i.exec(id)
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return (major === 3 && minor === 7) || (major === 4 && minor < 6)
}

/**
 * Reasoning variants for the effort values the catalog declares, spelled the
 * way OpenCode V2 spells them per protocol (packages/core/src/variant.ts).
 * Gateway model ids are opaque (`gwm_*`), so OpenCode cannot infer these from
 * the id; only the catalog's explicit `reasoning_options` produce variants.
 */
export function reasoningVariants(pkg: string, config: JsonRecord, upstreamModelId: string | null): ModelVariant[] {
  if (config.reasoning === false) return []
  const efforts = reasoningEfforts(config)
  if (!efforts.length) return []
  const spell = (settings: (effort: string) => Record<string, unknown>) =>
    efforts.map((effort) => ({ id: effort, settings: settings(effort) }))
  switch (pkg) {
    case "@opencode/ai/providers/openai":
    case "@opencode/ai/providers/azure/responses":
    case "@opencode/ai/providers/xai":
      return spell((effort) => ({ reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] }))
    case "@opencode/ai/providers/openai-compatible":
      return spell((effort) => ({ reasoningEffort: effort }))
    case "@opencode/ai/providers/anthropic":
    case "@opencode/ai/providers/google-vertex/messages":
      if (manualClaude(upstreamModelId)) return []
      return spell((effort) =>
        effort === "none"
          ? { thinking: { type: "disabled" } }
          : { thinking: { type: "adaptive", display: "summarized" }, effort },
      )
    case "@opencode/ai/providers/google":
    case "@opencode/ai/providers/google-vertex":
      return spell((effort) => ({ thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }))
    case "@opencode/ai/providers/openrouter":
      return spell((effort) => ({ reasoning: { effort } }))
    default:
      return []
  }
}

/** Older Den responses append "(group / credential set)" to model names; the picker shows the plain name. */
function displayName(model: GatewayModel): string {
  const selection = model.modelGroupName && model.credentialSetName
    ? ` (${model.modelGroupName} / ${model.credentialSetName})`
    : ""
  return selection && model.name.endsWith(selection) ? model.name.slice(0, -selection.length) : model.name
}

const STATUSES = new Set(["alpha", "beta", "deprecated", "active"])

export function toModelInfo(provider: GatewayProvider, model: GatewayModel, providerPkg: string): ModelInfo {
  const config = model.config
  const modelProvider = isRecord(config.provider) ? config.provider : {}
  const modelNpm = readString(modelProvider.npm)
  const pkg = modelNpm ? providerPackage(modelNpm) : providerPkg
  const modalities = isRecord(config.modalities) ? config.modalities : {}
  const limit = isRecord(config.limit) ? config.limit : {}
  const status = readString(config.status)
  const released = Date.parse(readString(config.release_date) ?? "")
  const settings = isRecord(config.options) ? { ...config.options } : undefined
  return {
    id: model.id,
    // Den sets config.id to the gwm alias; the gateway routes on it.
    modelID: readString(config.id) ?? model.id,
    providerID: provider.id,
    name: displayName(model),
    ...(readString(config.family) ? { family: readString(config.family) ?? undefined } : {}),
    ...(pkg !== providerPkg ? { package: pkg } : {}),
    ...(settings && Object.keys(settings).length ? { settings } : {}),
    ...(stringRecord(config.headers) ? { headers: stringRecord(config.headers) } : {}),
    capabilities: {
      tools: typeof config.tool_call === "boolean" ? config.tool_call : true,
      input: stringList(modalities.input, ["text", "image"]),
      output: stringList(modalities.output, ["text"]),
    },
    variants: reasoningVariants(pkg, config, model.upstreamModelId),
    time: { released: Number.isFinite(released) ? released : 0 },
    cost: costs(config.cost),
    status: status && STATUSES.has(status) ? (status as ModelInfo["status"]) : "active",
    enabled: status !== "deprecated",
    limit: {
      context: int(limit.context, 200_000),
      ...(typeof limit.input === "number" ? { input: int(limit.input, 0) } : {}),
      output: int(limit.output, 32_000),
    },
  }
}

/**
 * The integration gateway providers point at. It is never registered and never
 * holds a credential, so OpenCode always sends the gateway key from settings.
 * Without it OpenCode would look for a credential under the provider's own id
 * (`ipr_*`), and OpenCode 2 imports the desktop's V1 `auth.json`, which can
 * hold an older key under exactly those ids.
 */
export const GATEWAY_INTEGRATION_ID = "openwork-gateway"

export interface ProviderRecord {
  readonly info: ProviderInfo
  readonly models: readonly ModelInfo[]
}

export function toProviderRecord(provider: GatewayProvider, apiKey: string): ProviderRecord {
  const config = provider.providerConfig
  const pkg = providerPackage(readString(config.npm))
  const options = isRecord(config.options) ? config.options : {}
  const { headers, body, ...optionSettings } = options
  const baseURL = readString(config.api) ?? readString(options.baseURL)
  const info: ProviderInfo = {
    id: provider.id,
    name: provider.name,
    // Always available while signed in: the key is ours, not an integration credential.
    activation: "enabled",
    integrationID: GATEWAY_INTEGRATION_ID,
    package: pkg,
    settings: {
      ...optionSettings,
      ...(baseURL ? { baseURL } : {}),
      // OpenCode names the provider-options namespace of an openai-compatible route after its provider.
      ...(pkg === "@opencode/ai/providers/openai-compatible" ? { provider: provider.id } : {}),
      apiKey,
    },
    ...(stringRecord(headers) ? { headers: stringRecord(headers) } : {}),
    ...(isRecord(body) ? { body: { ...body } } : {}),
  }
  const models = [...provider.models]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((model) => toModelInfo(provider, model, pkg))
  return { info, models }
}
