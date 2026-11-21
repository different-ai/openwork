import { createHash, randomBytes } from "node:crypto"
import { createInferenceEgressFetch, validateInferenceUrl } from "@openwork-ee/gateway-upstreams"
import type { ModelsDevProvider } from "./models-dev.js"
import { matchTrueFoundryModel, trueFoundryModelConfig } from "./truefoundry-models.js"

type JsonRecord = Record<string, unknown>
export type TrueFoundryFetch = typeof fetch

export type TrueFoundryEndpoints = {
  controlPlaneUrl: string
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

export const TRUEFOUNDRY_TOKEN_NAME_PREFIX = "openwork-"
export const TRUEFOUNDRY_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000

const REQUEST_TIMEOUT_MS = 15_000
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

const TOKEN_NAME_MAX = 36
const LEGACY_TOKEN_NAME = /^openwork-[0-9a-f]{12}$/

export function trueFoundryProviderTag(providerId: string): string {
  return createHash("sha256").update(providerId).digest("hex").slice(0, 4)
}

export function trueFoundryTokenName(input: { email: string; providerId: string }): string {
  const suffix = `${trueFoundryProviderTag(input.providerId)}${randomBytes(1).toString("hex")}`
  const room = TOKEN_NAME_MAX - TRUEFOUNDRY_TOKEN_NAME_PREFIX.length - suffix.length - 1
  const slug = input.email.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, room).replace(/-+$/, "")
  return `${TRUEFOUNDRY_TOKEN_NAME_PREFIX}${slug ? `${slug}-` : ""}${suffix}`
}

export function isOpenWorkTrueFoundryToken(name: string, providerTag: string): boolean {
  return LEGACY_TOKEN_NAME.test(name) || name.startsWith(TRUEFOUNDRY_TOKEN_NAME_PREFIX) && new RegExp(`-${providerTag}[0-9a-f]{2}$`).test(name)
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

  async function registerUser(adminKey: string, email: string): Promise<void> {
    const path = "/api/svc/v1/users/register"
    const { status, body } = await request(path, adminKey, { method: "POST", body: { email: email.trim(), sendInviteEmail: false, skipIfUserExists: true } })
    if (status >= 200 && status < 300) return
    if (status === 403) throw new TrueFoundryError("not_admin", "This TrueFoundry key can't add users. Use a virtual account token with the tenant admin role.", 403)
    fail(path, status, body)
  }

  async function createUserToken(adminKey: string, input: { email: string; name: string; now?: Date }): Promise<string> {
    const path = "/api/svc/v1/personal-access-tokens/for-user"
    const base = { name: input.name, userEmail: input.email.trim() }
    const expirationDate = new Date((input.now ?? new Date()).getTime() + TRUEFOUNDRY_TOKEN_LIFETIME_MS).toISOString()
    let { status, body } = await request(path, adminKey, { method: "POST", body: { ...base, expirationDate } })
    if (status === 400 && /expir/i.test(readMessage(body) ?? "")) ({ status, body } = await request(path, adminKey, { method: "POST", body: base }))
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

  async function listOwnTokens(token: string, nameQuery: string): Promise<Array<{ id: string; name: string; createdAt: string | null }> | null> {
    const path = `/api/svc/v1/personal-access-tokens?nameSearchQuery=${encodeURIComponent(nameQuery)}&limit=100&offset=0`
    const { status, body } = await request(path, token)
    if (status === 401) return null
    if (status < 200 || status >= 300) fail(path, status, body)
    const rows = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : []
    return rows.flatMap((row) => {
      const id = readString(row.id)
      const name = (isRecord(row.manifest) ? readString(row.manifest.name) : null) ?? readString(row.name)
      return id && name ? [{ id, name, createdAt: readString(row.createdAt) }] : []
    })
  }

  async function ownTokenId(token: string, name: string): Promise<string | null> {
    return (await listOwnTokens(token, name))?.find((row) => row.name === name)?.id ?? null
  }

  async function deleteOwnToken(token: string, tokenId: string): Promise<void> {
    const path = `/api/svc/v1/personal-access-tokens/${encodeURIComponent(tokenId)}`
    const { status, body } = await request(path, token, { method: "DELETE" })
    if (status >= 200 && status < 300 || status === 401 || status === 404) return
    fail(path, status, body)
  }

  async function revokeAllUserTokens(adminKey: string, email: string): Promise<void> {
    const path = "/api/svc/v1/personal-access-tokens/revoke/all"
    const { status, body } = await request(path, adminKey, { method: "DELETE", body: { email: email.trim() } })
    if (status >= 200 && status < 300) return
    if (status === 404) throw new TrueFoundryError("user_not_found", `No TrueFoundry user has the email ${email}.`, 404)
    if (status === 403) throw new TrueFoundryError("not_admin", "This TrueFoundry key can't revoke people's tokens. Use a virtual account token with the tenant admin role.", 403)
    fail(path, status, body)
  }

  return { listModels, requireAdmin, findUserByEmail, registerUser, createUserToken, listOwnTokens, ownTokenId, deleteOwnToken, revokeAllUserTokens }
}

export type TrueFoundryClient = ReturnType<typeof createTrueFoundryClient>

export function trueFoundryCatalogModels(modelIds: readonly string[], catalog: readonly ModelsDevProvider[] = []): TrueFoundryModel[] {
  return modelIds.map((id) => {
    const config = trueFoundryModelConfig(id, catalog.length ? matchTrueFoundryModel(id, catalog) : null)
    return { id, name: typeof config.name === "string" ? config.name : id, config }
  })
}
