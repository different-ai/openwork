import { CONFIG_AREA_KEYS } from "@openwork/types/den/config-blobs"
import type { Context, MiddlewareHandler } from "hono"
import type { DenApiKeySession } from "../api-keys.js"
import type { AuthContextVariables } from "../session.js"

export type ConfigScope = "config:export" | "config:submit" | "config:apply"

type TokenVariables = { Variables: Partial<AuthContextVariables> }

function requestApiKey(c: Context): DenApiKeySession | null {
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  return apiKey ?? null
}

export function apiKeyHasConfigScope(apiKey: DenApiKeySession | null | undefined, scope: ConfigScope): boolean {
  return apiKey?.type === "config" && apiKey.configScopes.includes(scope)
}

export function requireConfigScope(scope: ConfigScope): MiddlewareHandler {
  const handler: MiddlewareHandler<TokenVariables> = async (c, next) => {
    const apiKey = requestApiKey(c)
    if (!apiKey) return next()
    if (apiKeyHasConfigScope(apiKey, scope)) return next()
    return c.json({ error: "config_scope_required", scope }, 403)
  }
  return handler
}

export const CONFIG_TOKEN_PATH_PREFIX = "/v1/config-blobs"

export function isConfigTokenPath(path: string): boolean {
  return path === CONFIG_TOKEN_PATH_PREFIX || path.startsWith(`${CONFIG_TOKEN_PATH_PREFIX}/`)
}

export const confineConfigTokens: MiddlewareHandler = async (c, next) => {
  const apiKey = requestApiKey(c)
  if (apiKey?.type !== "config" || isConfigTokenPath(c.req.path)) return next()
  return c.json({ error: "config_token_scope", message: "Config tokens only work with the Config API (/v1/config-blobs). Use a standard API key for other requests." }, 403)
}

export function getConfigTokenAreas(c: Context): string[] | null {
  const apiKey = requestApiKey(c)
  if (!apiKey) return null
  if (apiKey.type !== "config") return []
  return apiKey.configAreas ? [...apiKey.configAreas] : null
}

export function configTokenAllowsArea(areas: readonly string[] | null, areaKey: string): boolean {
  if (areas === null) return true
  return areas.some((entry) => {
    if (entry === areaKey) return true
    if (!entry.endsWith(".*")) return false
    const prefix = entry.slice(0, -1)
    return areaKey.startsWith(prefix)
  })
}

export function isConfigTokenAreaPattern(entry: string): boolean {
  if ((CONFIG_AREA_KEYS as readonly string[]).includes(entry)) return true
  if (!entry.endsWith(".*") || entry.length < 3) return false
  return CONFIG_AREA_KEYS.some((key) => configTokenAllowsArea([entry], key))
}

export function allowConfigTokenSecrets(apiKey: DenApiKeySession): boolean {
  return apiKeyHasConfigScope(apiKey, "config:submit")
}
