import { createHash } from "node:crypto"
import { classifyLiteLlmAuthError, type LiteLlmAuthErrorReason } from "@openwork-ee/gateway-catalog"
import { createInferenceEgressFetch, validateInferenceUrl } from "@openwork-ee/gateway-upstreams"
import type { ModelsDevProvider } from "./models-dev.js"
import { matchTrueFoundryModel as matchCatalogModel } from "./truefoundry-models.js"

type JsonRecord = Record<string, unknown>
export type LiteLlmFetch = typeof fetch

export type LiteLlmEndpoints = {
  inferenceBaseUrl: string
  adminBaseUrl: string
}

export type LiteLlmModel = { id: string; name: string; config: JsonRecord }
export type LiteLlmTeam = { id: string; alias: string | null; models: string[] }
export type LiteLlmKeyInfo = { teamId: string | null; userId: string | null; models: string[] }
export type LiteLlmUser = { userId: string; email: string; teams: string[]; models: string[] }
export type LiteLlmKeyRecord = {
  tokenId: string
  alias: string | null
  teamId: string | null
  models: string[]
  aliases: Record<string, string>
  tags: string[]
  metadata: JsonRecord
  blocked: boolean
  expiresAt: string | null
  createdAt: string | null
}
export type LiteLlmIssueRequest = {
  userId: string
  teamId: string | null
  alias: string
  metadata: JsonRecord
  models?: string[]
  aliases?: Record<string, string>
  tags?: string[]
  durationSeconds?: number
}

export const LITELLM_ISSUED_KEY_ALIAS_PREFIX = "openwork-"

export class LiteLlmError extends Error {
  constructor(readonly code: "invalid_base_url" | "unreachable" | "unauthorized" | "forbidden" | "not_admin" | "bad_response" | "no_models", message: string, readonly status: number | null = null) {
    super(message)
    this.name = "LiteLlmError"
  }
}

const REQUEST_TIMEOUT_MS = 10_000
const NON_CHAT_MODES = new Set(["embedding", "image_generation", "image_edit", "audio_transcription", "audio_speech", "rerank", "moderation", "video_generation", "ocr", "search"])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readPositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function readPrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

export function normalizeLiteLlmBaseUrl(raw: string): LiteLlmEndpoints {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new LiteLlmError("invalid_base_url", "Enter the LiteLLM proxy URL, for example https://litellm.example.com.") }
  if (url.username || url.password || url.search || url.hash) {
    throw new LiteLlmError("invalid_base_url", "The LiteLLM URL must not include credentials, a query string or a fragment.")
  }
  const root = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/i, "").replace(/\/v1$/i, "")
  url.pathname = root || "/"
  const adminBaseUrl = url.toString().replace(/\/+$/, "")
  try { validateInferenceUrl(adminBaseUrl, { base: true }) } catch {
    throw new LiteLlmError("invalid_base_url", "The LiteLLM URL must use HTTPS and a public host, or an origin your operator has approved.")
  }
  return { adminBaseUrl, inferenceBaseUrl: `${adminBaseUrl}/v1` }
}

export function createLiteLlmClient(endpoints: LiteLlmEndpoints, fetchImpl: LiteLlmFetch = createInferenceEgressFetch()) {
  async function request(path: string, key: string, body?: JsonRecord, notFound?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await fetchImpl(`${endpoints.adminBaseUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new LiteLlmError("unreachable", "OpenWork could not reach the LiteLLM proxy. Check the URL and that it accepts connections from OpenWork.")
    }
    if (response.status === 401) throw new LiteLlmError("unauthorized", "LiteLLM rejected the key.", 401)
    if (response.status === 403) throw new LiteLlmError("forbidden", "The LiteLLM key is not allowed to call this endpoint.", 403)
    if (response.status === 404 && notFound !== undefined) return notFound
    if (!response.ok) throw new LiteLlmError("bad_response", `LiteLLM returned HTTP ${response.status} for ${path.split("?")[0]}.`, response.status)
    try { return await response.json() } catch { throw new LiteLlmError("bad_response", `LiteLLM returned invalid JSON for ${path.split("?")[0]}.`) }
  }

  async function listModels(key: string): Promise<string[]> {
    const body = await request("/v1/models", key)
    if (!isRecord(body) || !Array.isArray(body.data)) throw new LiteLlmError("bad_response", "LiteLLM /v1/models returned an unexpected shape.")
    const ids = [...new Set(body.data.flatMap((entry) => {
      const id = isRecord(entry) ? readString(entry.id) : null
      return id && !id.includes("*") ? [id] : []
    }))].sort()
    const { modelIds, dropped } = dedupeLiteLlmModelIds(ids)
    if (dropped.length) console.warn("litellm_case_duplicate_models_dropped", { dropped })
    return modelIds
  }

  async function modelGroupInfo(key: string): Promise<Map<string, JsonRecord>> {
    try {
      const body = await request("/model_group/info", key)
      const rows = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : []
      const info = new Map<string, JsonRecord>()
      for (const row of rows) {
        const id = readString(row.model_group)
        if (id && !info.has(id)) info.set(id, row)
      }
      return info
    } catch (error) {
      if (error instanceof LiteLlmError && error.code === "unreachable") throw error
      return new Map()
    }
  }

  async function listTeams(adminKey: string): Promise<LiteLlmTeam[]> {
    const body = await request("/team/list", adminKey)
    const rows = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.teams) ? body.teams : isRecord(body) && Array.isArray(body.data) ? body.data : null
    if (!rows) throw new LiteLlmError("bad_response", "LiteLLM /team/list returned an unexpected shape.")
    return rows.filter(isRecord).flatMap((row) => {
      const id = readString(row.team_id)
      if (!id) return []
      const models = Array.isArray(row.models) ? row.models.flatMap((model) => readString(model) ?? []) : []
      return [{ id, alias: readString(row.team_alias), models }]
    })
  }

  async function keyInfo(key: string): Promise<LiteLlmKeyInfo | null> {
    try {
      const body = await request("/key/info", key)
      const info = isRecord(body) && isRecord(body.info) ? body.info : null
      if (!info) return null
      return { teamId: readString(info.team_id), userId: readString(info.user_id), models: Array.isArray(info.models) ? info.models.flatMap((model) => readString(model) ?? []) : [] }
    } catch (error) {
      if (error instanceof LiteLlmError && error.code === "unauthorized") throw error
      return null
    }
  }

  async function findUserByEmail(adminKey: string, email: string): Promise<LiteLlmUser | null> {
    const wanted = email.trim().toLowerCase()
    const body = await request(`/user/list?user_email=${encodeURIComponent(wanted)}&page=1&page_size=100`, adminKey)
    const rows = isRecord(body) && Array.isArray(body.users) ? body.users : Array.isArray(body) ? body : null
    if (!rows) throw new LiteLlmError("bad_response", "LiteLLM /user/list returned an unexpected shape.")
    const match = rows.filter(isRecord).find((row) => readString(row.user_email)?.toLowerCase() === wanted && readString(row.user_id))
    if (!match) return null
    const strings = (value: unknown) => Array.isArray(value) ? value.flatMap((entry) => readString(entry) ?? []) : []
    return { userId: readString(match.user_id) ?? "", email: readString(match.user_email) ?? wanted, teams: strings(match.teams), models: strings(match.models) }
  }

  async function userModels(adminKey: string, userId: string): Promise<string[] | null> {
    const body = await request(`/user/info?user_id=${encodeURIComponent(userId)}`, adminKey, undefined, null)
    const info = isRecord(body) && isRecord(body.user_info) ? body.user_info : null
    if (!info || readString(info.user_id) !== userId) return null
    return Array.isArray(info.models) ? info.models.flatMap((model) => readString(model) ?? []) : []
  }

  async function requireAdmin(key: string): Promise<LiteLlmTeam[]> {
    try { return await listTeams(key) } catch (error) {
      if (error instanceof LiteLlmError && (error.code === "unauthorized" || error.code === "forbidden")) {
        throw new LiteLlmError("not_admin", "This LiteLLM key can call models but can't manage LiteLLM. Use the master key or a proxy admin key.", error.status)
      }
      throw error
    }
  }

  async function listUserKeys(adminKey: string, userId: string): Promise<LiteLlmKeyRecord[]> {
    const body = await request(`/key/list?user_id=${encodeURIComponent(userId)}&return_full_object=true&page=1&size=100`, adminKey)
    const rows = isRecord(body) && Array.isArray(body.keys) ? body.keys : null
    if (!rows) throw new LiteLlmError("bad_response", "LiteLLM /key/list returned an unexpected shape.")
    const strings = (value: unknown) => Array.isArray(value) ? value.flatMap((entry) => readString(entry) ?? []) : []
    return rows.filter(isRecord).flatMap((row): LiteLlmKeyRecord[] => {
      const tokenId = readString(row.token)
      if (!tokenId) return []
      const aliases = isRecord(row.aliases) ? Object.fromEntries(Object.entries(row.aliases).flatMap(([name, target]) => typeof target === "string" ? [[name, target]] : [])) : {}
      return [{ tokenId, alias: readString(row.key_alias), teamId: readString(row.team_id), models: strings(row.models), aliases, tags: strings(row.tags),
        metadata: isRecord(row.metadata) ? row.metadata : {}, blocked: row.blocked === true, expiresAt: readString(row.expires), createdAt: readString(row.created_at) }]
    }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.tokenId.localeCompare(b.tokenId))
  }

  async function issueKey(adminKey: string, input: LiteLlmIssueRequest): Promise<{ key: string; tokenId: string }> {
    const body = await request("/key/generate", adminKey, {
      user_id: input.userId,
      ...(input.teamId ? { team_id: input.teamId } : {}),
      key_alias: input.alias,
      metadata: input.metadata,
      allowed_routes: ["llm_api_routes"],
      ...(input.models?.length ? { models: input.models } : {}),
      ...(input.aliases && Object.keys(input.aliases).length ? { aliases: input.aliases } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
      ...(input.durationSeconds !== undefined ? { duration: `${Math.max(60, Math.floor(input.durationSeconds))}s` } : {}),
    })
    const key = isRecord(body) ? readString(body.key) : null
    const tokenId = isRecord(body) ? readString(body.token_id) ?? readString(body.token) : null
    if (!key || !tokenId) throw new LiteLlmError("bad_response", "LiteLLM /key/generate returned no key.")
    return { key, tokenId }
  }

  async function deleteKeys(adminKey: string, tokenIds: string[]): Promise<void> {
    if (!tokenIds.length) return
    await request("/key/delete", adminKey, { keys: tokenIds }, { deleted_keys: [] })
  }

  return { listModels, modelGroupInfo, listTeams, requireAdmin, keyInfo, findUserByEmail, userModels, listUserKeys, issueKey, deleteKeys }
}

export type LiteLlmClient = ReturnType<typeof createLiteLlmClient>

export function liteLlmModelConfig(id: string, info: JsonRecord | undefined): JsonRecord {
  const config: JsonRecord = { id, name: id }
  if (!info) return config
  const context = readPositive(info.max_input_tokens) ?? readPositive(info.max_tokens)
  const output = readPositive(info.max_output_tokens)
  if (!context && !readString(info.mode)) return config
  if (context && output) config.limit = { context, output }
  const input = readPrice(info.input_cost_per_token)
  const outputPrice = readPrice(info.output_cost_per_token)
  if (input !== null && outputPrice !== null && input + outputPrice > 0) {
    const perMillion = (value: number) => Math.round(value * 1_000_000 * 1e6) / 1e6
    const cost: JsonRecord = { input: perMillion(input), output: perMillion(outputPrice) }
    const cacheRead = readPrice(info.cache_read_input_token_cost)
    const cacheWrite = readPrice(info.cache_creation_input_token_cost)
    if (cacheRead !== null) cost.cache_read = perMillion(cacheRead)
    if (cacheWrite !== null) cost.cache_write = perMillion(cacheWrite)
    config.cost = cost
  }
  if (typeof info.supports_function_calling === "boolean") config.tool_call = info.supports_function_calling
  if (typeof info.supports_reasoning === "boolean") config.reasoning = info.supports_reasoning
  if (typeof info.supports_vision === "boolean") config.attachment = info.supports_vision
  if (typeof info.supports_response_schema === "boolean") config.structured_output = info.supports_response_schema
  if (Array.isArray(info.supported_openai_params)) config.temperature = info.supported_openai_params.includes("temperature")
  config.modalities = { input: info.supports_vision === true ? ["text", "image"] : ["text"], output: ["text"] }
  return config
}

export function dedupeLiteLlmModelIds(ids: readonly string[]): { modelIds: string[]; dropped: string[] } {
  const seen = new Set<string>()
  const modelIds: string[] = []
  const dropped: string[] = []
  for (const id of ids) {
    const key = id.toLowerCase()
    if (seen.has(key)) dropped.push(id)
    else { seen.add(key); modelIds.push(id) }
  }
  return { modelIds, dropped }
}

export function liteLlmCatalogModels(modelIds: string[], info: Map<string, JsonRecord>): LiteLlmModel[] {
  return modelIds.flatMap((id) => {
    const facts = info.get(id)
    const mode = facts ? readString(facts.mode) : null
    if (mode && NON_CHAT_MODES.has(mode)) return []
    return [{ id, name: id, config: liteLlmModelConfig(id, facts) }]
  })
}

const STATIC_MODEL_FACTS = ["attachment", "reasoning", "reasoning_options", "tool_call", "structured_output", "temperature", "modalities", "limit"] as const

export function liteLlmStaticModels(modelIds: readonly string[], catalog: readonly ModelsDevProvider[] = []): LiteLlmModel[] {
  const ids = modelIds.map((id) => id.trim()).filter((id) => id && !id.includes("*"))
  return dedupeLiteLlmModelIds(ids).modelIds.map((id) => {
    const match = catalog.length ? matchCatalogModel(id, catalog) : null
    const facts = match ? Object.fromEntries(STATIC_MODEL_FACTS.flatMap((key) => match.model.config[key] === undefined ? [] : [[key, match.model.config[key]]])) : {}
    return { id, name: id, config: { ...facts, ...liteLlmModelConfig(id, undefined) } }
  })
}

export function liteLlmTeamModels(team: LiteLlmTeam, catalogIds: readonly string[]): string[] | null {
  if (!team.models.length || team.models.includes("all-proxy-models")) return [...catalogIds]
  const known = team.models.filter((model) => catalogIds.includes(model))
  return known.length === team.models.length ? [...new Set(known)].sort() : null
}

export function liteLlmModelSetKey(modelIds: readonly string[]): string {
  return `models:${createHash("sha256").update(JSON.stringify([...new Set(modelIds)].sort())).digest("base64url").slice(0, 22)}`
}

export function liteLlmPersonalModels(ownerModels: readonly string[], keyModels: readonly string[], catalogIds: readonly string[]): string[] | null {
  const restrict = (models: readonly string[]) => models.every((model) => catalogIds.includes(model)) ? [...new Set(models)].sort() : null
  if (ownerModels.includes("no-default-models")) return []
  const owner = ownerModels.length && !ownerModels.includes("all-proxy-models") ? restrict(ownerModels) : [...catalogIds].sort()
  if (owner === null) return null
  if (!keyModels.length || keyModels.includes("all-proxy-models")) return owner
  const key = restrict(keyModels)
  return key === null ? null : key.filter((model) => owner.includes(model))
}

export function liteLlmMirrorFingerprint(source: Pick<LiteLlmKeyRecord, "teamId" | "models" | "aliases" | "tags" | "expiresAt">): string {
  return createHash("sha256").update(JSON.stringify([source.teamId, [...source.models].sort(), Object.entries(source.aliases).sort(), [...source.tags].sort(), source.expiresAt])).digest("base64url").slice(0, 43)
}

const ENTRA_CONNECT_CHECK_TIMEOUT_MS = 4_000
const ENTRA_CONNECT_ERROR_BYTES = 4_096

export type LiteLlmEntraConnectCheck =
  | { outcome: "verified"; listedCount: number }
  | { outcome: "missing_models"; missingModels: string[]; warning: string }
  | { outcome: "rejected"; status: 401 | 403; reason: LiteLlmAuthErrorReason; warning: string }
  | { outcome: "skipped"; status: number | null; reason: "invalid_url" | "unreachable" | "bad_response" }

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const next = await reader.read()
      if (next.done) break
      const slice = next.value.byteLength > maxBytes - total ? next.value.subarray(0, maxBytes - total) : next.value
      chunks.push(slice)
      total += slice.byteLength
    }
  } catch {
    return ""
  } finally {
    await reader.cancel().catch(() => {})
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged)
}

function formatMissingModelsWarning(missingModels: readonly string[]): string {
  const shown = missingModels.slice(0, 5).join(", ")
  const remainder = missingModels.length > 5 ? ` and ${missingModels.length - 5} more` : ""
  return `LiteLLM accepted your Microsoft sign-in, but these configured models were not listed for your account: ${shown}${remainder}. Ask your LiteLLM administrator to check the model names and your user or team permissions.`
}

function entraConnectRejectedWarning(status: 401 | 403, reason: LiteLlmAuthErrorReason): string {
  if (reason === "user_not_found") {
    return "LiteLLM did not recognize your Microsoft account. Ask your LiteLLM administrator to add your user or enable user_id_upsert in LiteLLM."
  }
  if (status === 403) {
    if (reason === "budget_exceeded") {
      return "LiteLLM blocked this check because your LiteLLM budget limit was reached. Ask your LiteLLM administrator to check your user or team budget."
    }
    return "LiteLLM denied access for your Microsoft account. Ask your LiteLLM administrator to check your user or team permissions in LiteLLM."
  }
  if (reason === "jwt_mismatch") {
    return "LiteLLM rejected your Microsoft sign-in token. Ask your administrator to check the LiteLLM JWT issuer, audience, and v2 access token settings."
  }
  return "LiteLLM rejected your Microsoft sign-in token. Ask your administrator to check LiteLLM JWT settings (issuer, audience, and user mapping)."
}

export async function verifyLiteLlmEntraToken(input: {
  baseUrl: string
  accessToken: string
  configuredModels: readonly string[]
  fetchImpl?: LiteLlmFetch
  timeoutMs?: number
}): Promise<LiteLlmEntraConnectCheck> {
  let endpoints: LiteLlmEndpoints
  try { endpoints = normalizeLiteLlmBaseUrl(input.baseUrl) } catch {
    return { outcome: "skipped", status: null, reason: "invalid_url" }
  }
  const fetchImpl = input.fetchImpl ?? createInferenceEgressFetch()
  let response: Response
  try {
    response = await fetchImpl(`${endpoints.adminBaseUrl}/v1/models`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? ENTRA_CONNECT_CHECK_TIMEOUT_MS),
    })
  } catch {
    return { outcome: "skipped", status: null, reason: "unreachable" }
  }
  if (response.status === 401 || response.status === 403) {
    const reason = classifyLiteLlmAuthError(await readBoundedText(response, ENTRA_CONNECT_ERROR_BYTES))
    return { outcome: "rejected", status: response.status, reason, warning: entraConnectRejectedWarning(response.status, reason) }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    return { outcome: "skipped", status: response.status, reason: "bad_response" }
  }
  let body: unknown
  try { body = await response.json() } catch {
    return { outcome: "skipped", status: response.status, reason: "bad_response" }
  }
  if (!isRecord(body) || !Array.isArray(body.data)) {
    return { outcome: "skipped", status: response.status, reason: "bad_response" }
  }
  const returned = new Set<string>()
  for (const entry of body.data) {
    const id = isRecord(entry) ? readString(entry.id) : null
    if (id && !id.includes("*")) returned.add(id.toLowerCase())
  }
  const missingModels = input.configuredModels.filter((id) => !returned.has(id.toLowerCase()))
  if (missingModels.length > 0) {
    return { outcome: "missing_models", missingModels, warning: formatMissingModelsWarning(missingModels) }
  }
  return { outcome: "verified", listedCount: returned.size }
}
