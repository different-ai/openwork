import type { MiddlewareHandler } from "hono"
import type { DenApiKeySession } from "../api-keys.js"
import type { AuthContextVariables } from "../session.js"
import type { OrganizationContextVariables } from "./organization-context.js"

export const SECURE_ENTRY_REQUIRED = {
  error: "secure_entry_required",
  message: "Do not send keys through the agent or an API key. Leave the key out; the person adds it in a private field in OpenWork.",
} as const

export function bodyCarriesSecret(body: unknown, fields: readonly string[]): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false
  return fields.some((field) => {
    const value: unknown = Object.getOwnPropertyDescriptor(body, field)?.value
    return value !== undefined && value !== null && value !== ""
  })
}

export type RefuseMachineSecretsOptions = {
  allowApiKeys?: boolean | ((apiKey: DenApiKeySession) => boolean)
}

function apiKeyAllowed(apiKey: DenApiKeySession, allow: RefuseMachineSecretsOptions["allowApiKeys"]): boolean {
  return typeof allow === "function" ? allow(apiKey) : allow === true
}

export function refuseMachineSecrets(fields: readonly string[], options: RefuseMachineSecretsOptions = {}): MiddlewareHandler<{ Variables: Partial<AuthContextVariables & OrganizationContextVariables> }> {
  return async (c, next) => {
    const agent = c.get("session")?.id === "mcp_internal"
    const key = c.get("apiKey")
    const apiKey = Boolean(key) && !(key && apiKeyAllowed(key, options.allowApiKeys))
    if (!agent && !apiKey) return next()
    const body: unknown = await c.req.raw.clone().json().catch(() => null)
    if (!bodyCarriesSecret(body, fields)) return next()
    return c.json(SECURE_ENTRY_REQUIRED, 400)
  }
}
