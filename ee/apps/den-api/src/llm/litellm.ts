/**
 * LiteLLM proxy client and the mapping from LiteLLM's data model to ours.
 *
 *   LiteLLM model group (model_name)      -> gateway_provider_models row
 *   LiteLLM team / key model list          -> gateway_model_groups row (one per distinct model set)
 *   LiteLLM virtual key                    -> gateway_provider_credentials row (org or member subject)
 *
 * Only public model facts are read: /model_group/info carries no deployment
 * secrets, unlike /model/info's litellm_params. Every call is egress-guarded,
 * time-boxed and never follows redirects. Errors never echo keys.
 */
import { createHash } from "node:crypto"
import { createInferenceEgressFetch, validateInferenceUrl } from "@openwork-ee/utils/inference-egress"

type JsonRecord = Record<string, unknown>
export type LiteLlmFetch = typeof fetch

export type LiteLlmEndpoints = {
  /** OpenAI-compatible base the gateway forwards to, ending in /v1. */
  inferenceBaseUrl: string
  /** Proxy root for LiteLLM management routes (/team/list, /key/info, ...). */
  adminBaseUrl: string
}

export type LiteLlmModel = { id: string; name: string; config: JsonRecord }
export type LiteLlmTeam = { id: string; alias: string | null; models: string[] }
export type LiteLlmKeyInfo = { teamId: string | null; models: string[] }
export type LiteLlmUser = { userId: string; email: string; teams: string[]; models: string[] }
/** An existing key's settings. Never its value: LiteLLM keeps only a hash. */
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
  /** Seconds until expiry; omitted keys never expire. */
  durationSeconds?: number
}

/** Prefix of every key alias OpenWork creates, so mirroring never copies its own keys. */
export const LITELLM_ISSUED_KEY_ALIAS_PREFIX = "openwork-"

export class LiteLlmError extends Error {
  constructor(readonly code: "invalid_base_url" | "unreachable" | "unauthorized" | "forbidden" | "bad_response" | "no_models", message: string, readonly status: number | null = null) {
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

/** Accepts the proxy root or its /v1 base, with or without a trailing slash. */
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

  /** The models this key may call: LiteLLM applies key, team and access-group rules. */
  async function listModels(key: string): Promise<string[]> {
    const body = await request("/v1/models", key)
    if (!isRecord(body) || !Array.isArray(body.data)) throw new LiteLlmError("bad_response", "LiteLLM /v1/models returned an unexpected shape.")
    return [...new Set(body.data.flatMap((entry) => {
      const id = isRecord(entry) ? readString(entry.id) : null
      // Wildcard routes (openai/*) are not callable model ids.
      return id && !id.includes("*") ? [id] : []
    }))].sort()
  }

  /** Public per-model facts. Best-effort: older proxies or locked-down keys may refuse it. */
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

  /** Requires an admin key. Shapes differ across LiteLLM versions. */
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

  /** The calling key's own record. Best-effort: some deployments restrict /key/info. */
  async function keyInfo(key: string): Promise<LiteLlmKeyInfo | null> {
    try {
      const body = await request("/key/info", key)
      const info = isRecord(body) && isRecord(body.info) ? body.info : null
      if (!info) return null
      return { teamId: readString(info.team_id), models: Array.isArray(info.models) ? info.models.flatMap((model) => readString(model) ?? []) : [] }
    } catch (error) {
      if (error instanceof LiteLlmError && error.code === "unauthorized") throw error
      return null
    }
  }

  /** Exact, case-insensitive email match. LiteLLM's filter is a substring search. Requires an admin key. */
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

  /** A user's keys, oldest first. Values are never returned, only settings. Requires an admin key. */
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

  /**
   * Creates a key owned by the user. It may only call models: LiteLLM's
   * llm_api_routes, so a key owned by a LiteLLM admin never inherits admin rights.
   * Key-level budgets and rate limits are never set. Requires an admin key.
   */
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

  /** Deletes keys by token hash. Keys already gone count as deleted. Requires an admin key. */
  async function deleteKeys(adminKey: string, tokenIds: string[]): Promise<void> {
    if (!tokenIds.length) return
    await request("/key/delete", adminKey, { keys: tokenIds }, { deleted_keys: [] })
  }

  return { listModels, modelGroupInfo, listTeams, keyInfo, findUserByEmail, listUserKeys, issueKey, deleteKeys }
}

export type LiteLlmClient = ReturnType<typeof createLiteLlmClient>

/**
 * models.dev-shaped model config from LiteLLM's public model-group facts.
 * Costs are converted from USD per token to USD per 1M tokens, which is what
 * the gateway's pricing reads. Unknown facts are omitted, never guessed.
 */
export function liteLlmModelConfig(id: string, info: JsonRecord | undefined): JsonRecord {
  const config: JsonRecord = { id, name: id }
  if (!info) return config
  const context = readPositive(info.max_input_tokens) ?? readPositive(info.max_tokens)
  const output = readPositive(info.max_output_tokens)
  // LiteLLM reports models missing from its cost map with null limits, $0 prices
  // and every capability false. Those are unknowns, not facts: omit them.
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

/** Chat-capable models with their configs. Embedding, image and audio models are left out. */
export function liteLlmCatalogModels(modelIds: string[], info: Map<string, JsonRecord>): LiteLlmModel[] {
  return modelIds.flatMap((id) => {
    const facts = info.get(id)
    const mode = facts ? readString(facts.mode) : null
    if (mode && NON_CHAT_MODES.has(mode)) return []
    return [{ id, name: id, config: liteLlmModelConfig(id, facts) }]
  })
}

/**
 * A team's callable models. LiteLLM treats an empty list or `all-proxy-models`
 * as everything; other names that are not model ids are access groups, which
 * only the proxy can expand, so they resolve through member keys instead.
 */
export function liteLlmTeamModels(team: LiteLlmTeam, catalogIds: readonly string[]): string[] | null {
  if (!team.models.length || team.models.includes("all-proxy-models")) return [...catalogIds]
  const known = team.models.filter((model) => catalogIds.includes(model))
  return known.length === team.models.length ? [...new Set(known)].sort() : null
}

/** Stable identity of a model set, so members with the same access share one group. */
export function liteLlmModelSetKey(modelIds: readonly string[]): string {
  return `models:${createHash("sha256").update(JSON.stringify([...new Set(modelIds)].sort())).digest("base64url").slice(0, 22)}`
}

/**
 * Models a key without a team can call. LiteLLM's /v1/models over-reports for
 * these keys, so read the owner's own list: empty means every model on the
 * proxy, `no-default-models` means none outside a team. Names that are not
 * model ids (access groups) cannot be expanded here, so the caller falls back
 * to the key's own listing. Returns null in that case.
 */
export function liteLlmPersonalModels(ownerModels: readonly string[], keyModels: readonly string[], catalogIds: readonly string[]): string[] | null {
  const restrict = (models: readonly string[]) => models.every((model) => catalogIds.includes(model)) ? [...new Set(models)].sort() : null
  if (ownerModels.includes("no-default-models")) return []
  const owner = ownerModels.length && !ownerModels.includes("all-proxy-models") ? restrict(ownerModels) : [...catalogIds].sort()
  if (owner === null) return null
  if (!keyModels.length || keyModels.includes("all-proxy-models")) return owner
  const key = restrict(keyModels)
  return key === null ? null : key.filter((model) => owner.includes(model))
}

/** Settings a mirrored key copies. A change means the copy must be recreated. Limits are never copied. */
export function liteLlmMirrorFingerprint(source: Pick<LiteLlmKeyRecord, "teamId" | "models" | "aliases" | "tags" | "expiresAt">): string {
  return createHash("sha256").update(JSON.stringify([source.teamId, [...source.models].sort(), Object.entries(source.aliases).sort(), [...source.tags].sort(), source.expiresAt])).digest("base64url").slice(0, 43)
}
