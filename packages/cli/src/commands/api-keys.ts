import { api } from "../api.ts"
import { confirmDestructive, dryRun, noArgs, oneArg, openSession, splitList, withRecentSignIn, type Context } from "../context.ts"
import { parseApiKeys, parseCreatedApiKey, type ApiKey } from "../den.ts"
import { CliError } from "../io.ts"
import { emit, table } from "../output.ts"

function keyByIdOrName(keys: ApiKey[], wanted: string): ApiKey {
  const byId = keys.find((key) => key.id === wanted)
  if (byId) return byId
  const named = keys.filter((key) => key.name === wanted)
  if (named.length === 1 && named[0]) return named[0]
  throw new CliError(named.length ? "ambiguous_api_key" : "unknown_api_key", named.length
    ? `${named.length} API keys are named "${wanted}". Use the id from \`openwork api-keys list\`.`
    : `No API key with the id or name "${wanted}". Run \`openwork api-keys list\`.`)
}

export async function list(context: Context): Promise<void> {
  noArgs(context)
  const session = await openSession(context)
  const apiKeys = parseApiKeys(await api(context.io, session, "GET", "/v1/api-keys"))
  emit(context.io, context.json, { apiKeys }, apiKeys.length
    ? table(["ID", "NAME", "TYPE", "SCOPES", "OWNER", "LAST USED", "EXPIRES"],
      apiKeys.map((key) => [key.id, key.name, key.type, key.scopes.join(","), key.owner, key.lastUsedAt?.slice(0, 10) ?? "never", key.expiresAt?.slice(0, 10)]))
    : "No API keys.")
}

/**
 * Create a key and print it once. A config token is a key of type config with
 * scopes, and optionally a limit to some configuration areas; naming scopes is
 * enough to ask for one.
 */
export async function create(context: Context): Promise<void> {
  const name = oneArg(context, "key name")
  const scopes = splitList(context.flags.scopes)
  const areas = splitList(context.flags.areas)
  const type = context.flags.type ?? (scopes.length ? "config" : "standard")
  if (type !== "standard" && type !== "config") throw new CliError("usage", "--type is standard or config.")
  if (type === "config" && !scopes.length) throw new CliError("usage", "A config token needs --scopes, for example --scopes config:export,config:submit.")
  const body = { name, ...(type === "config" ? { type, scopes, ...(areas.length ? { areas } : {}) } : {}) }
  const session = await openSession(context)
  if (dryRun(context, "POST", "/v1/api-keys", body)) return
  const created = parseCreatedApiKey(await withRecentSignIn(context, session, (current) => api(context.io, current, "POST", "/v1/api-keys", body)))
  emit(context.io, context.json, created, [
    `Created ${created.type === "config" ? `config token ${created.name} (${created.scopes.join(", ")})` : `API key ${created.name}`}${created.expiresAt ? `, valid until ${created.expiresAt.slice(0, 10)}` : ""}.`,
    created.key,
    "Store it now: it is not shown again.",
  ].join("\n"))
}

export async function remove(context: Context): Promise<void> {
  const wanted = oneArg(context, "key id or name")
  const session = await openSession(context)
  const key = keyByIdOrName(parseApiKeys(await api(context.io, session, "GET", "/v1/api-keys")), wanted)
  const path = `/v1/api-keys/${encodeURIComponent(key.id)}`
  if (dryRun(context, "DELETE", path)) return
  await confirmDestructive(context, `Delete API key ${key.name}? Anything using it stops working.`)
  await withRecentSignIn(context, session, (current) => api(context.io, current, "DELETE", path))
  emit(context.io, context.json, { id: key.id, name: key.name, deleted: true }, `Deleted API key ${key.name}.`)
}
