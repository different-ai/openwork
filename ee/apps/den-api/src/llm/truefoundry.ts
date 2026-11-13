/**
 * TrueFoundry control-plane and gateway client, and the mapping from
 * TrueFoundry's data model to ours.
 *
 *   TrueFoundry gateway model (provider/model)  -> gateway_provider_models row
 *   models one person's token can reach          -> gateway_model_groups row (one per distinct set)
 *   TrueFoundry user (found by email)            -> gateway_truefoundry_users row
 *   personal access token created for the user   -> gateway_provider_credentials row (member subject)
 *
 * Every call is egress-guarded, time-boxed and never follows redirects.
 * Errors never echo keys or tokens.
 *
 * TrueFoundry rules this relies on, checked against a live tenant:
 * - Only a tenant-admin virtual account (not a personal access token) may
 *   create a personal access token for another user.
 * - An admin cannot list or delete another user's tokens; a token can list
 *   and delete itself.
 * - Each user may hold a few personal access tokens (a tenant setting, often 3),
 *   so OpenWork keeps exactly one per person and reuses it.
 */
import { randomBytes } from "node:crypto"
import { createInferenceEgressFetch, validateInferenceUrl } from "@openwork-ee/utils/inference-egress"
import type { ModelsDevProvider } from "./models-dev.js"
import { matchTrueFoundryModel, trueFoundryModelConfig } from "./truefoundry-models.js"

type JsonRecord = Record<string, unknown>
export type TrueFoundryFetch = typeof fetch

export type TrueFoundryEndpoints = {
  /** Control plane root, e.g. https://acme.truefoundry.cloud. Management routes live under /api/svc. */
  controlPlaneUrl: string
  /** OpenAI-compatible gateway base the AI Gateway forwards to, e.g. https://acme.truefoundry.cloud/api/llm. */
  gatewayBaseUrl: string
}

export type TrueFoundryUser = { id: string; email: string; active: boolean }
export type TrueFoundryModel = { id: string; name: string; config: JsonRecord }

export type TrueFoundryErrorCode =
  | "invalid_url"
  | "unreachable"
  | "unauthorized"
  | "forbidden"
  | "not_admin"
  | "personal_token"
  | "user_not_found"
  | "token_limit"
  | "bad_response"
  | "no_models"

export class TrueFoundryError extends Error {
  constructor(readonly code: TrueFoundryErrorCode, message: string, readonly status: number | null = null) {
    super(message)
    this.name = "TrueFoundryError"
  }
}

/** Prefix of every token name OpenWork creates, so they are easy to recognize in TrueFoundry. */
export const TRUEFOUNDRY_TOKEN_NAME_PREFIX = "openwork-"

const REQUEST_TIMEOUT_MS = 15_000
/** Model types that are not chat models. Models without a type are kept. */
const CHAT_TYPES = new Set(["chat"])

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function readMessage(body: unknown): string | null {
  return isRecord(body) ? readString(body.message) ?? (isRecord(body.error) ? readString(body.error.message) : null) : null
}

function validUrl(raw: string): URL {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new TrueFoundryError("invalid_url", "Enter your TrueFoundry address, for example https://acme.truefoundry.cloud.") }
  if (url.username || url.password || url.search || url.hash) {
    throw new TrueFoundryError("invalid_url", "The TrueFoundry address must not include credentials, a query string or a fragment.")
  }
  return url
}

function checkedBase(url: URL, label: string): string {
  const base = url.toString().replace(/\/+$/, "")
  try { validateInferenceUrl(base, { base: true }) } catch {
    throw new TrueFoundryError("invalid_url", `The TrueFoundry ${label} must use HTTPS and a public host, or an origin your operator has approved.`)
  }
  return base
}

/**
 * Accepts the control plane root (the address people open TrueFoundry at),
 * with or without a trailing slash or path. The gateway defaults to
 * `<control plane>/api/llm`; tenants that run the gateway on another host
 * pass it explicitly, with or without a trailing `/v1` or `/chat/completions`.
 */
export function normalizeTrueFoundryEndpoints(controlPlane: string, gateway?: string | null): TrueFoundryEndpoints {
  const root = validUrl(controlPlane)
  root.pathname = "/"
  const controlPlaneUrl = checkedBase(root, "address")
  let gatewayBaseUrl = `${controlPlaneUrl}/api/llm`
  if (gateway && gateway.trim()) {
    const url = validUrl(gateway)
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|models)$/i, "") || "/"
    gatewayBaseUrl = checkedBase(url, "gateway address")
  }
  try { validateInferenceUrl(gatewayBaseUrl, { base: true }) } catch {
    throw new TrueFoundryError("invalid_url", "The TrueFoundry gateway address must use HTTPS and a public host, or an origin your operator has approved.")
  }
  return { controlPlaneUrl, gatewayBaseUrl }
}

/** A name TrueFoundry accepts for a personal access token: 3-36 lowercase letters, digits and dashes. */
export function trueFoundryTokenName(): string {
  return `${TRUEFOUNDRY_TOKEN_NAME_PREFIX}${randomBytes(6).toString("hex")}`
}

export function createTrueFoundryClient(endpoints: TrueFoundryEndpoints, fetchImpl: TrueFoundryFetch = createInferenceEgressFetch()) {
  type Options = { method?: "GET" | "POST" | "DELETE"; body?: JsonRecord; base?: "control" | "gateway" }
  async function request(path: string, key: string, options: Options = {}): Promise<{ status: number; body: unknown }> {
    const base = options.base === "gateway" ? endpoints.gatewayBaseUrl : endpoints.controlPlaneUrl
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: options.method ?? "GET",
        headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      throw new TrueFoundryError("unreachable", "OpenWork could not reach TrueFoundry. Check the address and that it accepts connections from OpenWork.")
    }
    let body: unknown = null
    const text = await response.text().catch(() => "")
    if (text) { try { body = JSON.parse(text) } catch { body = null } }
    return { status: response.status, body }
  }

  function fail(path: string, status: number, body: unknown): never {
    if (status === 401) throw new TrueFoundryError("unauthorized", "TrueFoundry rejected the key.", 401)
    if (status === 403) throw new TrueFoundryError("forbidden", "The TrueFoundry key is not allowed to do this.", 403)
    const detail = readMessage(body)
    throw new TrueFoundryError("bad_response", `TrueFoundry returned HTTP ${status} for ${path.split("?")[0]}${detail ? `: ${detail.slice(0, 200)}` : "."}`, status)
  }

  /** Chat models this key may call, from the gateway's own access rules. */
  async function listModels(key: string): Promise<string[]> {
    const { status, body } = await request("/models", key, { base: "gateway" })
    if (status < 200 || status >= 300) fail("/models", status, body)
    if (!isRecord(body) || !Array.isArray(body.data)) throw new TrueFoundryError("bad_response", "TrueFoundry /models returned an unexpected shape.")
    return [...new Set(body.data.flatMap((entry) => {
      if (!isRecord(entry)) return []
      const id = readString(entry.id)
      const types = Array.isArray(entry.model_types) ? entry.model_types.flatMap((type) => readString(type) ?? []) : []
      return id && (!types.length || types.some((type) => CHAT_TYPES.has(type))) ? [id] : []
    }))].sort()
  }

  /**
   * Proves the key can manage users: a dry-run registration needs tenant admin.
   * Personal access tokens are refused up front, because TrueFoundry never lets
   * them create tokens for other people.
   */
  async function requireAdmin(adminKey: string): Promise<void> {
    if (adminKey.startsWith("tfy_pat_")) {
      throw new TrueFoundryError("personal_token", "This is a personal access token. Use a TrueFoundry virtual account token with the tenant admin role.")
    }
    const path = "/api/svc/v1/users/register"
    const { status, body } = await request(path, adminKey, { method: "POST", body: { email: "openwork-admin-check@openwork.invalid", dryRun: true, skipIfUserExists: true } })
    if (status >= 200 && status < 300) return
    if (status === 401) throw new TrueFoundryError("unauthorized", "TrueFoundry rejected the key.", 401)
    if (status === 403) throw new TrueFoundryError("not_admin", "This TrueFoundry key can't manage users. Use a virtual account token with the tenant admin role.", 403)
    fail(path, status, body)
  }

  /** Exact, case-insensitive email match among active users. TrueFoundry's query is a search. */
  async function findUserByEmail(adminKey: string, email: string): Promise<TrueFoundryUser | null> {
    const wanted = email.trim().toLowerCase()
    const path = `/api/svc/v1/users?query=${encodeURIComponent(wanted)}&limit=100&offset=0`
    const { status, body } = await request(path, adminKey)
    if (status < 200 || status >= 300) fail(path, status, body)
    if (!isRecord(body) || !Array.isArray(body.data)) throw new TrueFoundryError("bad_response", "TrueFoundry /users returned an unexpected shape.")
    const match = body.data.filter(isRecord).find((row) => readString(row.email)?.toLowerCase() === wanted && readString(row.id))
    if (!match) return null
    return { id: readString(match.id) ?? "", email: readString(match.email) ?? wanted, active: match.active !== false }
  }

  /**
   * Adds the email to the tenant with TrueFoundry's default member role, without
   * sending an invite email (people on SSO sign in through their identity provider).
   */
  async function registerUser(adminKey: string, email: string): Promise<void> {
    const path = "/api/svc/v1/users/register"
    const { status, body } = await request(path, adminKey, { method: "POST", body: { email: email.trim(), sendInviteEmail: false, skipIfUserExists: true } })
    if (status >= 200 && status < 300) return
    if (status === 403) throw new TrueFoundryError("not_admin", "This TrueFoundry key can't add users. Use a virtual account token with the tenant admin role.", 403)
    fail(path, status, body)
  }

  /** Creates a personal access token owned by the user. Requires a tenant-admin virtual account. */
  async function createUserToken(adminKey: string, input: { email: string; name: string }): Promise<string> {
    const path = "/api/svc/v1/personal-access-tokens/for-user"
    const { status, body } = await request(path, adminKey, { method: "POST", body: { name: input.name, userEmail: input.email.trim() } })
    const token = isRecord(body) ? readString(body.token) : null
    if (status >= 200 && status < 300) {
      if (!token) throw new TrueFoundryError("bad_response", "TrueFoundry created no token.")
      return token
    }
    const message = readMessage(body) ?? ""
    if (status === 404) throw new TrueFoundryError("user_not_found", `No TrueFoundry user has the email ${input.email}.`, 404)
    if (status === 400 && /maximum number of personal access tokens/i.test(message)) {
      throw new TrueFoundryError("token_limit", "This person already has the most personal access tokens TrueFoundry allows. Delete one of theirs in TrueFoundry, then check again.", 400)
    }
    if (status === 403 || status === 400 && /personal access token/i.test(message)) {
      throw new TrueFoundryError("not_admin", "This TrueFoundry key can't create tokens for people. Use a virtual account token with the tenant admin role.", status)
    }
    fail(path, status, body)
  }

  /** The id of a token, read with the token itself (admins cannot list other users' tokens). */
  async function ownTokenId(token: string, name: string): Promise<string | null> {
    const path = `/api/svc/v1/personal-access-tokens?nameSearchQuery=${encodeURIComponent(name)}&limit=100&offset=0`
    const { status, body } = await request(path, token)
    if (status === 401) return null
    if (status < 200 || status >= 300) fail(path, status, body)
    const rows = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : []
    const match = rows.find((row) => isRecord(row.manifest) && readString(row.manifest.name) === name) ?? rows.find((row) => readString(row.name) === name)
    return match ? readString(match.id) : null
  }

  /** Deletes a token with the token itself. A token TrueFoundry already rejects counts as deleted. */
  async function deleteOwnToken(token: string, tokenId: string): Promise<void> {
    const path = `/api/svc/v1/personal-access-tokens/${encodeURIComponent(tokenId)}`
    const { status, body } = await request(path, token, { method: "DELETE" })
    if (status >= 200 && status < 300 || status === 401 || status === 404) return
    fail(path, status, body)
  }

  return { listModels, requireAdmin, findUserByEmail, registerUser, createUserToken, ownTokenId, deleteOwnToken }
}

export type TrueFoundryClient = ReturnType<typeof createTrueFoundryClient>

/**
 * TrueFoundry's gateway lists chat model ids only. Each model keeps its id and
 * takes its name, capabilities and limits from the matching models.dev model
 * (see truefoundry-models.ts); unmatched models get the id as their name and
 * no limits. Prices are never copied.
 */
export function trueFoundryCatalogModels(modelIds: readonly string[], catalog: readonly ModelsDevProvider[] = []): TrueFoundryModel[] {
  return modelIds.map((id) => {
    const config = trueFoundryModelConfig(id, catalog.length ? matchTrueFoundryModel(id, catalog) : null)
    return { id, name: typeof config.name === "string" ? config.name : id, config }
  })
}
