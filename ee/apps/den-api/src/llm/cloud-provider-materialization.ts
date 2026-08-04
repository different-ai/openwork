import { createHash } from "node:crypto"
import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import {
  LlmProviderModelTable,
  LlmProviderTable,
  WorkerTable,
  WorkerTokenTable,
} from "@openwork-ee/den-db/schema"
import { db } from "../db.js"
import { appLogger } from "../observability/logger.js"
import { decodeProviderCredential, readProviderEnvNames } from "./provider-credentials.js"

type JsonRecord = Record<string, unknown>
type OrganizationId = typeof LlmProviderTable.$inferSelect.organizationId
type WorkerId = typeof WorkerTable.$inferSelect.id
type WorkerTokenScope = typeof WorkerTokenTable.$inferSelect.scope
type LlmProviderId = typeof LlmProviderTable.$inferSelect.id
type LlmProviderSource = typeof LlmProviderTable.$inferSelect.source

type EnvEntry = {
  key: string
  value: string
}

type EnvSnapshot = Map<string, string | null>

type WorkerToken = {
  scope: WorkerTokenScope
  token: string
}

export type CloudProviderMaterializationProvider = {
  id: LlmProviderId
  source: LlmProviderSource
  providerId: string
  name: string
  providerConfig: JsonRecord
  apiKey: string | null
  models: Array<{
    modelId: string
    name: string
    modelConfig: JsonRecord
  }>
}

export type CloudProviderMaterializationStore = {
  listProviders: (organizationId: OrganizationId) => Promise<CloudProviderMaterializationProvider[]>
  getActiveTokens: (workerId: WorkerId) => Promise<WorkerToken[]>
}

type MaterializedProvider = {
  provider: CloudProviderMaterializationProvider
  runtimeProviderId: string
  config: JsonRecord
  envEntries: EnvEntry[]
}

type PreparedMaterialization = {
  fingerprint: string
  providers: MaterializedProvider[]
  envEntries: EnvEntry[]
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>

type MaterializationLogger = {
  warn: (message: string, metadata?: JsonRecord) => void
  error: (message: string, metadata?: JsonRecord) => void
}

export type CloudProviderMaterializationResult =
  | {
      ok: true
      status: "applied" | "noop" | "cached"
      fingerprint: string
      providers: number
    }
  | {
      ok: false
      status: "failed"
      error: "provider_materialization_failed"
      reason: string
      message: string
      fingerprint: string | null
      providers: number
    }
  | {
      ok: false
      status: "unsupported"
      error: "provider_materialization_unsupported"
      reason: string
      message: string
      fingerprint: string | null
      providers: number
    }

export type MaterializeCloudWorkerProviders = typeof materializeCloudWorkerProviders

const logger = appLogger.child({ component: "cloud_provider_materialization" })
const requestTimeoutMs = 8_000
/**
 * Cache of what we have already materialized, keyed by worker AND instance.
 *
 * Keying by worker alone was a bug: a recycle onto a new snapshot replaces the
 * sandbox, and the new instance starts with an empty env store (only the runtime
 * config survives, on the shared volume). With a worker-only key den-api kept
 * answering "cached" and never wrote the credential into the new instance, so
 * every provider failed with "API key is missing" while still showing up in the
 * picker.
 */
const materializedFingerprintByWorkerInstance = new Map<string, string>()

function materializationCacheKey(workerId: WorkerId, instanceUrl: string): string {
  return `${workerId}\u0000${instanceUrl}`
}
const unsupportedLogFingerprintByWorker = new Map<WorkerId, string>()
const modelConfigPassthroughKeys = [
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "modalities",
  "status",
  "options",
  "headers",
  "provider",
  "variants",
]

const databaseMaterializationStore: CloudProviderMaterializationStore = {
  async listProviders(organizationId) {
    const providers = await db
      .select()
      .from(LlmProviderTable)
      .where(eq(LlmProviderTable.organizationId, organizationId))
      .orderBy(asc(LlmProviderTable.id))

    if (providers.length === 0) {
      return []
    }

    const providerIds = providers.map((provider) => provider.id)
    const models = await db
      .select()
      .from(LlmProviderModelTable)
      .where(inArray(LlmProviderModelTable.llmProviderId, providerIds))
      .orderBy(asc(LlmProviderModelTable.llmProviderId), asc(LlmProviderModelTable.modelId))

    const modelsByProvider = new Map<LlmProviderId, CloudProviderMaterializationProvider["models"]>()
    for (const model of models) {
      const existing = modelsByProvider.get(model.llmProviderId) ?? []
      existing.push({
        modelId: model.modelId,
        name: model.name,
        modelConfig: model.modelConfig,
      })
      modelsByProvider.set(model.llmProviderId, existing)
    }

    return providers.map((provider) => ({
      id: provider.id,
      source: provider.source,
      providerId: provider.providerId,
      name: provider.name,
      providerConfig: provider.providerConfig,
      apiKey: provider.apiKey ?? null,
      models: modelsByProvider.get(provider.id) ?? [],
    }))
  },
  async getActiveTokens(workerId) {
    return db
      .select({ scope: WorkerTokenTable.scope, token: WorkerTokenTable.token })
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
  },
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue)
  }

  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  )
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value))
}

function hashString(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "")
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : []
}

function runtimeProviderId(provider: Pick<CloudProviderMaterializationProvider, "id" | "source">) {
  return provider.source === "openwork" ? "openwork" : provider.id.trim()
}

function isCloudManagedProviderKey(providerId: string) {
  return /^lpr_/i.test(providerId) || providerId.trim() === "openwork"
}

function upsertEnvEntry(entries: EnvEntry[], key: string, value: string) {
  const trimmedKey = key.trim()
  const trimmedValue = value.trim()
  if (!trimmedKey || !trimmedValue) {
    return
  }

  const existing = entries.find((entry) => entry.key === trimmedKey)
  if (existing) {
    existing.value = trimmedValue
    return
  }

  entries.push({ key: trimmedKey, value: trimmedValue })
}

function readOpenWorkInferenceBaseUrl(providerConfig: JsonRecord) {
  const options = providerConfig.options
  if (isRecord(options)) {
    const baseUrl = readString(options.baseURL)
    if (baseUrl) {
      return baseUrl.replace(/\/api\/v1\/?$/, "")
    }
  }

  const api = readString(providerConfig.api)
  return api ? api.replace(/\/api\/v1\/?$/, "") : null
}

function providerEnvEntries(provider: CloudProviderMaterializationProvider): EnvEntry[] {
  const entries: EnvEntry[] = []
  const envNames = readProviderEnvNames(provider.providerConfig)
  const credential = decodeProviderCredential(provider.apiKey)

  if (credential.apiKeys) {
    const keys = Object.keys(credential.apiKeys)
    const orderedNames = [
      ...envNames.filter((name) => keys.includes(name)),
      ...keys.filter((name) => !envNames.includes(name)),
    ]
    for (const name of orderedNames) {
      upsertEnvEntry(entries, name, credential.apiKeys[name] ?? "")
    }
  }

  if (credential.apiKey && envNames[0]) {
    upsertEnvEntry(entries, envNames[0], credential.apiKey)
  }

  const primaryCredential = credential.apiKey?.trim() || entries[0]?.value || ""
  if (provider.source === "openwork" && primaryCredential) {
    upsertEnvEntry(entries, "OPENWORK_API_KEY", primaryCredential)
    const baseUrl = readOpenWorkInferenceBaseUrl(provider.providerConfig)
    if (baseUrl) {
      upsertEnvEntry(entries, "OPENWORK_INFERENCE_BASE_URL", baseUrl)
    }
  }

  return entries
}

function buildModelConfig(model: CloudProviderMaterializationProvider["models"][number]) {
  const next: JsonRecord = {
    id: model.modelId,
    name: model.name,
  }

  for (const key of modelConfigPassthroughKeys) {
    const value = model.modelConfig[key]
    if (value !== undefined) {
      next[key] = value
    }
  }

  return next
}

function buildProviderConfig(provider: CloudProviderMaterializationProvider) {
  const models: JsonRecord = {}
  const sortedModels = [...provider.models].sort((left, right) => left.modelId.localeCompare(right.modelId))
  for (const model of sortedModels) {
    models[model.modelId] = buildModelConfig(model)
  }

  const config: JsonRecord = {
    id: provider.providerId,
    name: provider.name,
    env: readProviderEnvNames(provider.providerConfig),
  }

  if (Object.keys(models).length > 0 || provider.source !== "openwork") {
    config.models = models
  }

  const npm = readString(provider.providerConfig.npm)
  if (npm) {
    config.npm = npm
  }

  const api = readString(provider.providerConfig.api)
  if (api) {
    config.api = api
  }

  const options = provider.providerConfig.options
  if (isRecord(options)) {
    config.options = options
  }

  const whitelist = readStringList(provider.providerConfig.whitelist)
  if (whitelist.length > 0) {
    config.whitelist = whitelist
  }

  const blacklist = readStringList(provider.providerConfig.blacklist)
  if (blacklist.length > 0) {
    config.blacklist = blacklist
  }

  return config
}

function providerHasRequiredCredential(provider: CloudProviderMaterializationProvider, envEntries: EnvEntry[]) {
  const envNames = readProviderEnvNames(provider.providerConfig)
  if (envNames.length === 0) {
    return true
  }

  return envEntries.some((entry) => envNames.includes(entry.key))
}

function prepareMaterialization(providers: CloudProviderMaterializationProvider[]): PreparedMaterialization {
  const materialized = providers
    .map((provider) => {
      const envEntries = providerEnvEntries(provider)
      if (!providerHasRequiredCredential(provider, envEntries)) {
        return null
      }

      return {
        provider,
        runtimeProviderId: runtimeProviderId(provider),
        config: buildProviderConfig(provider),
        envEntries,
      }
    })
    .filter((entry): entry is MaterializedProvider => entry !== null)
    .sort((left, right) => left.runtimeProviderId.localeCompare(right.runtimeProviderId))

  const envEntries: EnvEntry[] = []
  for (const provider of materialized) {
    for (const entry of provider.envEntries) {
      upsertEnvEntry(envEntries, entry.key, entry.value)
    }
  }

  const fingerprintPayload = materialized.map((entry) => ({
    id: entry.provider.id,
    runtimeProviderId: entry.runtimeProviderId,
    source: entry.provider.source,
    providerId: entry.provider.providerId,
    config: entry.config,
    keyHashes: entry.envEntries
      .map((envEntry) => ({ key: envEntry.key, hash: hashString(envEntry.value) }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  }))

  return {
    fingerprint: `owp:v1:${hashString(stableJson(fingerprintPayload))}`,
    providers: materialized,
    envEntries,
  }
}

export function computeCloudProviderMaterializationFingerprint(providers: CloudProviderMaterializationProvider[]) {
  return prepareMaterialization(providers).fingerprint
}

async function fetchWithTimeout(fetchImpl: FetchImpl, url: string, init: RequestInit = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function readJsonObject(response: Response) {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }

  const parsed = JSON.parse(text)
  return isRecord(parsed) ? parsed : {}
}

function bearerHeaders(clientToken: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${clientToken}`,
  }
}

function hostTokenHeaders(hostToken: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-OpenWork-Host-Token": hostToken,
  }
}

class MaterializationHttpError extends Error {
  readonly label: string
  readonly status: number
  readonly responseBody: string

  constructor(label: string, status: number, responseBody = "") {
    super(`${label}_failed_${status}`)
    this.name = "MaterializationHttpError"
    this.label = label
    this.status = status
    this.responseBody = responseBody
  }
}

async function requestJson(input: {
  fetchImpl: FetchImpl
  label: string
  url: string
  init: RequestInit
}) {
  const response = await fetchWithTimeout(input.fetchImpl, input.url, input.init)
  if (!response.ok) {
    throw new MaterializationHttpError(input.label, response.status)
  }

  return readJsonObject(response)
}

async function requestOk(input: {
  fetchImpl: FetchImpl
  label: string
  url: string
  init: RequestInit
}) {
  const response = await fetchWithTimeout(input.fetchImpl, input.url, input.init)
  if (!response.ok) {
    throw new MaterializationHttpError(input.label, response.status, await response.text())
  }
}

async function readRuntimeManagedProviders(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  clientToken: string
}) {
  const payload = await requestJson({
    fetchImpl: input.fetchImpl,
    label: "engine_config_read",
    url: `${input.instanceUrl}/opencode/config`,
    init: {
      method: "GET",
      headers: bearerHeaders(input.clientToken),
    },
  })
  const provider = isRecord(payload.provider) ? payload.provider : null
  const managed: JsonRecord = {}
  if (!provider) {
    return managed
  }

  for (const [providerId, config] of Object.entries(provider)) {
    if (isCloudManagedProviderKey(providerId) && isRecord(config)) {
      managed[providerId] = config
    }
  }

  return managed
}

function readRuntimeSnapshotVersion(payload: JsonRecord) {
  const services = Array.isArray(payload.services) ? payload.services : []
  let fallback: string | null = null
  for (const service of services) {
    if (!isRecord(service)) {
      continue
    }

    const version = readString(service.actualVersion) ?? readString(service.targetVersion)
    if (!version) {
      continue
    }

    fallback = fallback ?? version
    const serviceName = readString(service.name)?.toLowerCase()
    if (serviceName?.includes("openwork") || serviceName?.includes("server")) {
      return version
    }
  }

  return fallback
}

async function readInstanceVersion(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  clientToken: string
}) {
  try {
    const payload = await requestJson({
      fetchImpl: input.fetchImpl,
      label: "runtime_versions_read",
      url: `${input.instanceUrl}/runtime/versions`,
      init: {
        method: "GET",
        headers: bearerHeaders(input.clientToken),
      },
    })

    return readRuntimeSnapshotVersion(payload)
  } catch {
    return null
  }
}

function buildRuntimeProviderPatch(prepared: PreparedMaterialization, currentManagedProviders: JsonRecord) {
  const desiredIds = new Set(prepared.providers.map((provider) => provider.runtimeProviderId))
  const patch: JsonRecord = {}
  for (const providerId of Object.keys(currentManagedProviders)) {
    if (!desiredIds.has(providerId)) {
      patch[providerId] = null
    }
  }

  for (const provider of prepared.providers) {
    patch[provider.runtimeProviderId] = provider.config
  }

  return patch
}

function materializedProviderStateMatches(prepared: PreparedMaterialization, currentManagedProviders: JsonRecord) {
  const desiredManagedProviders: JsonRecord = {}
  for (const provider of prepared.providers) {
    desiredManagedProviders[provider.runtimeProviderId] = provider.config
  }

  return stableJson(currentManagedProviders) === stableJson(desiredManagedProviders)
}

function materializedEnvStateMatches(entries: EnvEntry[], snapshot: EnvSnapshot) {
  return entries.every((entry) => snapshot.get(entry.key) === entry.value)
}

function buildRuntimeProviderRollbackPatch(prepared: PreparedMaterialization, currentManagedProviders: JsonRecord) {
  const affectedIds = new Set([
    ...Object.keys(currentManagedProviders),
    ...prepared.providers.map((provider) => provider.runtimeProviderId),
  ])
  const patch: JsonRecord = {}
  for (const providerId of affectedIds) {
    patch[providerId] = currentManagedProviders[providerId] ?? null
  }

  return patch
}

async function readEnvEntry(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  hostToken: string
  key: string
}) {
  const response = await fetchWithTimeout(input.fetchImpl, `${input.instanceUrl}/env/${encodeURIComponent(input.key)}`, {
    method: "GET",
    headers: hostTokenHeaders(input.hostToken),
  })
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`env_read_failed_${response.status}`)
  }

  const payload = await readJsonObject(response)
  const item = isRecord(payload.item) ? payload.item : null
  return item && typeof item.value === "string" ? { key: input.key, value: item.value } : null
}

async function readEnvSnapshot(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  hostToken: string
  entries: EnvEntry[]
}): Promise<EnvSnapshot> {
  const snapshot: EnvSnapshot = new Map()
  for (const entry of input.entries) {
    if (snapshot.has(entry.key)) {
      continue
    }
    const existing = await readEnvEntry({
      fetchImpl: input.fetchImpl,
      instanceUrl: input.instanceUrl,
      hostToken: input.hostToken,
      key: entry.key,
    })
    snapshot.set(entry.key, existing?.value ?? null)
  }

  return snapshot
}

async function writeEnvEntries(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  hostToken: string
  entries: EnvEntry[]
}) {
  if (input.entries.length === 0) {
    return
  }

  await requestOk({
    fetchImpl: input.fetchImpl,
    label: "env_write",
    url: `${input.instanceUrl}/env`,
    init: {
      method: "PUT",
      headers: hostTokenHeaders(input.hostToken),
      body: JSON.stringify({ entries: input.entries }),
    },
  })
}

async function deleteEnvEntry(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  hostToken: string
  key: string
  ignoreNotFound?: boolean
}) {
  const response = await fetchWithTimeout(input.fetchImpl, `${input.instanceUrl}/env/${encodeURIComponent(input.key)}`, {
    method: "DELETE",
    headers: hostTokenHeaders(input.hostToken),
  })
  if (response.status === 404 && input.ignoreNotFound) {
    return
  }
  if (!response.ok) {
    throw new Error(`env_delete_failed_${response.status}`)
  }
}

async function restoreEnvSnapshot(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  hostToken: string
  snapshot: EnvSnapshot
}) {
  const entries: EnvEntry[] = []
  const deleteKeys: string[] = []
  for (const [key, value] of input.snapshot) {
    if (value === null) {
      deleteKeys.push(key)
    } else {
      entries.push({ key, value })
    }
  }

  await writeEnvEntries({
    fetchImpl: input.fetchImpl,
    instanceUrl: input.instanceUrl,
    hostToken: input.hostToken,
    entries,
  })
  for (const key of deleteKeys) {
    await deleteEnvEntry({
      fetchImpl: input.fetchImpl,
      instanceUrl: input.instanceUrl,
      hostToken: input.hostToken,
      key,
      ignoreNotFound: true,
    })
  }
}

async function patchRuntimeProviders(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  hostToken: string
  patch: JsonRecord
}) {
  const response = await fetchWithTimeout(input.fetchImpl, `${input.instanceUrl}/runtime-config/providers`, {
    method: "PATCH",
    headers: hostTokenHeaders(input.hostToken),
    body: JSON.stringify({ provider: input.patch }),
  })
  if (!response.ok) {
    throw new MaterializationHttpError("runtime_provider_patch", response.status, await response.text())
  }

  // An instance older than this route answers 200 with the SPA index.html
  // instead of 404, because the web root is the catch-all. Observed on a real
  // worker still running openwork-server 0.18.3: the patch "succeeded", the
  // engine ended up with zero providers, and the org saw an opaque failure
  // instead of "this workspace needs an update". Treat a non-JSON body as an
  // unsupported route so the caller can degrade honestly.
  const body = await response.text()
  if (!looksLikeJsonObject(body)) {
    throw new MaterializationHttpError("runtime_provider_patch", UNSUPPORTED_ROUTE_STATUS, body.slice(0, 200))
  }
}

/**
 * Synthetic status for "this instance does not implement the route", used when
 * the instance answers 200 with something that is not the route's JSON.
 */
const UNSUPPORTED_ROUTE_STATUS = 501

function looksLikeJsonObject(body: string): boolean {
  const trimmed = body.trim()
  if (!trimmed.startsWith("{")) return false
  try {
    return typeof JSON.parse(trimmed) === "object"
  } catch {
    return false
  }
}

async function verifyRuntimeProviders(input: {
  fetchImpl: FetchImpl
  instanceUrl: string
  clientToken: string
  providerIds: string[]
}) {
  if (input.providerIds.length === 0) {
    return
  }

  const payload = await requestJson({
    fetchImpl: input.fetchImpl,
    label: "provider_readback",
    url: `${input.instanceUrl}/opencode/config`,
    init: {
      method: "GET",
      headers: bearerHeaders(input.clientToken),
    },
  })
  const provider = isRecord(payload.provider) ? payload.provider : null
  for (const providerId of input.providerIds) {
    if (!provider || !Object.prototype.hasOwnProperty.call(provider, providerId)) {
      throw new Error(`provider_readback_missing_${providerId}`)
    }
  }
}

async function resolveTokens(input: {
  workerId: WorkerId
  hostToken?: string
  clientToken?: string
  store: CloudProviderMaterializationStore
}) {
  let hostToken = input.hostToken?.trim() ?? ""
  let clientToken = input.clientToken?.trim() ?? ""
  if (hostToken && clientToken) {
    return { hostToken, clientToken }
  }

  const tokens = await input.store.getActiveTokens(input.workerId)
  hostToken = hostToken || tokens.find((token) => token.scope === "host")?.token.trim() || ""
  clientToken = clientToken || tokens.find((token) => token.scope === "client")?.token.trim() || ""
  return { hostToken, clientToken }
}

function failureResult(input: {
  reason: string
  error: unknown
  fingerprint: string | null
  providers: number
}) {
  const message = input.error instanceof MaterializationHttpError && input.error.responseBody
    ? `${input.error.message}: ${input.error.responseBody}`
    : input.error instanceof Error ? input.error.message : input.reason
  return {
    ok: false,
    status: "failed",
    error: "provider_materialization_failed",
    reason: input.reason,
    message,
    fingerprint: input.fingerprint,
    providers: input.providers,
  } satisfies CloudProviderMaterializationResult
}

function unsupportedResult(input: {
  reason: string
  fingerprint: string | null
  providers: number
}) {
  return {
    ok: false,
    status: "unsupported",
    error: "provider_materialization_unsupported",
    reason: input.reason,
    message: input.reason,
    fingerprint: input.fingerprint,
    providers: input.providers,
  } satisfies CloudProviderMaterializationResult
}

function unsupportedProviderRouteReason(error: unknown) {
  return error instanceof MaterializationHttpError
    && error.label === "runtime_provider_patch"
    && (error.status === 404 || error.status === 405 || error.status === UNSUPPORTED_ROUTE_STATUS)
    ? error.message
    : null
}

function logFailure(input: {
  logger: MaterializationLogger
  workerId: WorkerId
  organizationId: OrganizationId
  result: Extract<CloudProviderMaterializationResult, { ok: false }>
  cause: unknown
}) {
  const metadata = {
    worker_id: input.workerId,
    organization_id: input.organizationId,
    reason: input.result.reason,
    message: input.result.message,
    fingerprint: input.result.fingerprint,
    providers: input.result.providers,
  }
  if (
    input.cause instanceof MaterializationHttpError
    && input.cause.status >= 400
    && input.cause.status < 500
    && (input.cause.label === "env_write" || input.cause.label === "runtime_provider_patch")
  ) {
    input.logger.error("cloud provider materialization write rejected", {
      ...metadata,
      status: input.cause.status,
      response_body: input.cause.responseBody,
    })
    return
  }

  input.logger.warn("cloud provider materialization failed", metadata)
}

async function logUnsupportedOnce(input: {
  logger: MaterializationLogger
  workerId: WorkerId
  organizationId: OrganizationId
  fingerprint: string
  providers: number
  reason: string
  fetchImpl: FetchImpl
  instanceUrl: string
  clientToken: string
}) {
  if (unsupportedLogFingerprintByWorker.get(input.workerId) === input.fingerprint) {
    return
  }

  unsupportedLogFingerprintByWorker.set(input.workerId, input.fingerprint)
  const instanceVersion = await readInstanceVersion({
    fetchImpl: input.fetchImpl,
    instanceUrl: input.instanceUrl,
    clientToken: input.clientToken,
  })

  input.logger.warn("cloud provider materialization unsupported by worker version", {
    worker_id: input.workerId,
    organization_id: input.organizationId,
    reason: input.reason,
    fingerprint: input.fingerprint,
    providers: input.providers,
    instance_version: instanceVersion,
  })
}

// den-api must tolerate instances older than itself: sandbox images ship on the
// release/snapshot cadence while den-api deploys from dev.
export async function materializeCloudWorkerProviders(input: {
  organizationId: OrganizationId
  workerId: WorkerId
  instanceUrl: string
  hostToken?: string
  clientToken?: string
  force?: boolean
  store?: CloudProviderMaterializationStore
  fetchImpl?: FetchImpl
  logger?: MaterializationLogger
}): Promise<CloudProviderMaterializationResult> {
  const materializationLogger = input.logger ?? logger
  const store = input.store ?? databaseMaterializationStore
  const fetchImpl = input.fetchImpl ?? fetch
  const instanceUrl = normalizeBaseUrl(input.instanceUrl)
  let fingerprint: string | null = null
  let providerCount = 0

  try {
    if (!instanceUrl) {
      throw new Error("instance_url_missing")
    }

    const providers = await store.listProviders(input.organizationId)
    const prepared = prepareMaterialization(providers)
    fingerprint = prepared.fingerprint
    providerCount = prepared.providers.length

    const cacheKey = materializationCacheKey(input.workerId, instanceUrl)
    if (!input.force && materializedFingerprintByWorkerInstance.get(cacheKey) === fingerprint) {
      return { ok: true, status: "cached", fingerprint, providers: providerCount }
    }

    const tokens = await resolveTokens({
      workerId: input.workerId,
      hostToken: input.hostToken,
      clientToken: input.clientToken,
      store,
    })
    if (!tokens.hostToken || !tokens.clientToken) {
      throw new Error("worker_tokens_missing")
    }
    const desiredProviderIds = prepared.providers.map((provider) => provider.runtimeProviderId)
    const currentManagedProviders = await readRuntimeManagedProviders({
      fetchImpl,
      instanceUrl,
      clientToken: tokens.clientToken,
    })
    const providerPatch = buildRuntimeProviderPatch(prepared, currentManagedProviders)
    const providerRollbackPatch = buildRuntimeProviderRollbackPatch(prepared, currentManagedProviders)
    const envSnapshot = await readEnvSnapshot({
      fetchImpl,
      instanceUrl,
      hostToken: tokens.hostToken,
      entries: prepared.envEntries,
    })
    if (
      materializedProviderStateMatches(prepared, currentManagedProviders)
      && materializedEnvStateMatches(prepared.envEntries, envSnapshot)
    ) {
      materializedFingerprintByWorkerInstance.set(cacheKey, fingerprint)
      return { ok: true, status: "noop", fingerprint, providers: providerCount }
    }

    let envWritten = false
    let providerPatched = false

    try {
      await writeEnvEntries({
        fetchImpl,
        instanceUrl,
        hostToken: tokens.hostToken,
        entries: prepared.envEntries,
      })
      envWritten = prepared.envEntries.length > 0
      providerPatched = true
      await patchRuntimeProviders({
        fetchImpl,
        instanceUrl,
        hostToken: tokens.hostToken,
        patch: providerPatch,
      })
      await verifyRuntimeProviders({
        fetchImpl,
        instanceUrl,
        clientToken: tokens.clientToken,
        providerIds: desiredProviderIds,
      })
    } catch (error) {
      const unsupportedReason = unsupportedProviderRouteReason(error)
      if (unsupportedReason) {
        materializedFingerprintByWorkerInstance.delete(cacheKey)
        await logUnsupportedOnce({
          logger: materializationLogger,
          workerId: input.workerId,
          organizationId: input.organizationId,
          fingerprint: prepared.fingerprint,
          providers: providerCount,
          reason: unsupportedReason,
          fetchImpl,
          instanceUrl,
          clientToken: tokens.clientToken,
        })
        return unsupportedResult({
          reason: unsupportedReason,
          fingerprint: prepared.fingerprint,
          providers: providerCount,
        })
      }

      if (providerPatched) {
        await patchRuntimeProviders({
          fetchImpl,
          instanceUrl,
          hostToken: tokens.hostToken,
          patch: providerRollbackPatch,
        }).catch((rollbackError) => {
          materializationLogger.warn("cloud provider rollback failed", {
            worker_id: input.workerId,
            organization_id: input.organizationId,
            reason: rollbackError instanceof Error ? rollbackError.message : "runtime_config_rollback_failed",
          })
        })
      }
      if (envWritten) {
        await restoreEnvSnapshot({
          fetchImpl,
          instanceUrl,
          hostToken: tokens.hostToken,
          snapshot: envSnapshot,
        }).catch((rollbackError) => {
          materializationLogger.warn("cloud provider env rollback failed", {
            worker_id: input.workerId,
            organization_id: input.organizationId,
            reason: rollbackError instanceof Error ? rollbackError.message : "env_rollback_failed",
          })
        })
      }
      throw error
    }

    materializedFingerprintByWorkerInstance.set(cacheKey, fingerprint)
    return { ok: true, status: "applied", fingerprint, providers: providerCount }
  } catch (error) {
    const result = failureResult({
      reason: error instanceof Error ? error.message : "provider_materialization_failed",
      error,
      fingerprint,
      providers: providerCount,
    })
    logFailure({
      logger: materializationLogger,
      workerId: input.workerId,
      organizationId: input.organizationId,
      result,
      cause: error,
    })
    return result
  }
}
