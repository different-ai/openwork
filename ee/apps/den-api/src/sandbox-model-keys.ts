import { env } from "./env.js"
import { appLogger } from "./observability/logger.js"

/**
 * One OpenRouter key per sandbox, capped with OpenRouter's own spending limit, minted with the deployment's
 * management key. Den stores only the key's hash; the key itself lives in the sandbox's AI Gateway credential
 * set, so members never see it. Separate from OpenWork Models (inference.ts), which never sees these keys.
 */
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys"
const TIMEOUT_MS = 10_000

export type SandboxModelKeyState = { limitUsd: number | null; remainingUsd: number | null; disabled: boolean }

export function sandboxMintsModelKeys() {
  return env.gatewayEnabled && env.sandbox.gateway !== null && env.sandbox.gateway.apiKey === null && Boolean(env.openRouterManagementApiKey)
}

function managementKey() {
  const key = env.openRouterManagementApiKey
  if (!key) throw new Error("openrouter_management_api_key_missing")
  return key
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

async function call(path: string, init: { method: string; body?: Record<string, unknown> }) {
  const response = await fetch(`${OPENROUTER_KEYS_URL}${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${managementKey()}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const payload: unknown = await response.json().catch(() => null)
  return { response, payload }
}

function failure(action: string, status: number, payload: unknown) {
  const message = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : `HTTP ${status}`
  return new Error(`OpenRouter ${action} failed: ${message}`)
}

export async function createSandboxModelKey(input: { organizationId: string; name: string; limitUsd: number }) {
  const { response, payload } = await call("", {
    method: "POST",
    body: {
      name: `OpenWork sandbox ${input.organizationId} (${input.name})`.slice(0, 200),
      limit: input.limitUsd,
      include_byok_in_limit: false,
      ...(env.openRouterWorkspaceId ? { workspace_id: env.openRouterWorkspaceId } : {}),
    },
  })
  if (!response.ok || !isRecord(payload) || typeof payload.key !== "string" || !isRecord(payload.data) || typeof payload.data.hash !== "string") {
    throw failure("key creation", response.status, payload)
  }
  return { key: payload.key, hash: payload.data.hash }
}

export async function updateSandboxModelKey(hash: string, changes: { limitUsd?: number; disabled?: boolean }) {
  const { response, payload } = await call(`/${encodeURIComponent(hash)}`, {
    method: "PATCH",
    body: { ...(changes.limitUsd === undefined ? {} : { limit: changes.limitUsd }), ...(changes.disabled === undefined ? {} : { disabled: changes.disabled }) },
  })
  if (!response.ok) throw failure("key update", response.status, payload)
}

export async function readSandboxModelKey(hash: string): Promise<SandboxModelKeyState | null> {
  try {
    const { response, payload } = await call(`/${encodeURIComponent(hash)}`, { method: "GET" })
    if (!response.ok || !isRecord(payload) || !isRecord(payload.data)) return null
    return { limitUsd: numberOrNull(payload.data.limit), remainingUsd: numberOrNull(payload.data.limit_remaining), disabled: payload.data.disabled === true }
  } catch (error) {
    appLogger.warn("sandbox model key read failed", { error: error instanceof Error ? error.message : "unknown" })
    return null
  }
}

export async function deleteSandboxModelKey(hash: string) {
  const { response, payload } = await call(`/${encodeURIComponent(hash)}`, { method: "DELETE" })
  if (!response.ok && response.status !== 404) throw failure("key deletion", response.status, payload)
}
