import { CONFIG_AREA_KEYS } from "@openwork/types/den/config-blobs"
import type { Context, MiddlewareHandler } from "hono"
import type { DenApiKeySession } from "../api-keys.js"
import type { AuthContextVariables } from "../session.js"

/**
 * Config tokens: organization API keys of type `config` (feature `configBlobs`).
 * Design: docs/features/config-blobs/change-requests.md ("Config token").
 *
 * Storage: scopes in the Better Auth `apikey.permissions` column as
 * `{"config":["export","submit","apply"]}`; `type: "config"` and the optional
 * `areas` limit in the key's metadata JSON, next to its organization binding
 * (see api-keys.ts). A config token still acts as the member who issued it: a
 * scope only opens the config-blob routes, the member's permissions decide what
 * it may change.
 *
 * Scopes are independent (`config:apply` does not imply `config:submit`):
 * - `config:export`: download blobs.
 * - `config:submit`: upload change requests and read them (list, status, plan),
 *   set mappings and inputs. Reading change requests needs `config:submit`.
 * - `config:apply`: approve, apply and revert (D3).
 */
export type ConfigScope = "config:export" | "config:submit" | "config:apply"

type TokenVariables = { Variables: Partial<AuthContextVariables> }

function requestApiKey(c: Context): DenApiKeySession | null {
  const apiKey: DenApiKeySession | null | undefined = c.get("apiKey")
  return apiKey ?? null
}

/** Whether this API key is a config token holding `scope`. */
export function apiKeyHasConfigScope(apiKey: DenApiKeySession | null | undefined, scope: ConfigScope): boolean {
  return apiKey?.type === "config" && apiKey.configScopes.includes(scope)
}

/**
 * The only API-key gate on config-blob routes. A signed-in UI session (no API
 * key) passes; an API key passes only when it is a config token with `scope`.
 * Standard API keys and config tokens without the scope get
 * 403 `{ error: "config_scope_required", scope }`. Member permissions are
 * still checked by the route and its adapters.
 */
export function requireConfigScope(scope: ConfigScope): MiddlewareHandler {
  const handler: MiddlewareHandler<TokenVariables> = async (c, next) => {
    const apiKey = requestApiKey(c)
    if (!apiKey) return next()
    if (apiKeyHasConfigScope(apiKey, scope)) return next()
    return c.json({ error: "config_scope_required", scope }, 403)
  }
  return handler
}

/** The only paths a config token may call: the config-blob routes. */
export const CONFIG_TOKEN_PATH_PREFIX = "/v1/config-blobs"

export function isConfigTokenPath(path: string): boolean {
  return path === CONFIG_TOKEN_PATH_PREFIX || path.startsWith(`${CONFIG_TOKEN_PATH_PREFIX}/`)
}

/**
 * Global middleware (app.ts, after the session and audit middleware): a config
 * token is confined to `/v1/config-blobs/*`. Everywhere else, REST and MCP
 * alike, it gets 403 `config_token_scope`, so a leaked CI token can't act as
 * its member on the rest of the API. Standard API keys and sessions pass.
 */
export const confineConfigTokens: MiddlewareHandler = async (c, next) => {
  const apiKey = requestApiKey(c)
  if (apiKey?.type !== "config" || isConfigTokenPath(c.req.path)) return next()
  return c.json({ error: "config_token_scope", message: "Config tokens only work with the Config API (/v1/config-blobs). Use a standard API key for other requests." }, 403)
}

/**
 * Area limit for this request: null = every area (UI sessions and unrestricted
 * config tokens). A standard API key gets [] (nothing): it never passes
 * requireConfigScope anyway.
 */
export function getConfigTokenAreas(c: Context): string[] | null {
  const apiKey = requestApiKey(c)
  if (!apiKey) return null
  if (apiKey.type !== "config") return []
  return apiKey.configAreas ? [...apiKey.configAreas] : null
}

/** Whether an area limit (from getConfigTokenAreas) covers `areaKey`. Entries are area keys or `prefix.*`. */
export function configTokenAllowsArea(areas: readonly string[] | null, areaKey: string): boolean {
  if (areas === null) return true
  return areas.some((entry) => {
    if (entry === areaKey) return true
    if (!entry.endsWith(".*")) return false
    const prefix = entry.slice(0, -1)
    return areaKey.startsWith(prefix)
  })
}

/** A valid area-limit entry: a known area key, or `prefix.*` covering at least one known area. */
export function isConfigTokenAreaPattern(entry: string): boolean {
  if ((CONFIG_AREA_KEYS as readonly string[]).includes(entry)) return true
  if (!entry.endsWith(".*") || entry.length < 3) return false
  return CONFIG_AREA_KEYS.some((key) => configTokenAllowsArea([entry], key))
}

/**
 * `refuseMachineSecrets(fields, { allowApiKeys: allowConfigTokenSecrets })`:
 * only a config token with `config:submit` may send secret values (the change
 * request inputs endpoint). Standard API keys and the agent stay refused.
 */
export function allowConfigTokenSecrets(apiKey: DenApiKeySession): boolean {
  return apiKeyHasConfigScope(apiKey, "config:submit")
}
