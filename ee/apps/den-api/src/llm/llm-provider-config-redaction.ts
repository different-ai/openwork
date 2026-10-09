type JsonRecord = Record<string, unknown>

// View-only callers (no llm_providers.update, not the creator, not granted) get an
// allowlist of fields known to be non-secret, rebuilt from scratch; anything else
// in a stored configuration, at any depth, is dropped. Custom providers keep
// arbitrary fields, so a deny-list can never be complete.

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/
const MODALITY = /^[a-z][a-z0-9_-]{0,31}$/i
const MAX_TEXT = 255

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function matchingStrings(value: unknown, pattern: RegExp): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === "string" && pattern.test(entry))
}

/**
 * The origin (scheme, host and port) of an http(s) URL; undefined when it isn't one. Path, userinfo,
 * query string and fragment are all dropped: any of them can carry a credential (e.g. /key/<secret>/v1).
 */
export function credentialFreeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  return url.origin
}

function numberRecord(value: unknown, keys: readonly string[]): JsonRecord | undefined {
  if (!isRecord(value)) return undefined
  const picked = Object.fromEntries(keys.flatMap((key) => {
    const entry = finiteNumber(value[key])
    return entry === undefined ? [] : [[key, entry]]
  }))
  return Object.keys(picked).length > 0 ? picked : undefined
}

function compact(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

/** The non-secret view of a provider configuration (models.dev or custom). */
export function viewOnlyLlmProviderConfig(config: JsonRecord): JsonRecord {
  const baseURL = isRecord(config.options) ? credentialFreeUrl(config.options.baseURL) : undefined
  return compact({
    id: text(config.id),
    name: text(config.name),
    npm: text(config.npm),
    env: matchingStrings(config.env, ENV_NAME),
    doc: credentialFreeUrl(config.doc),
    api: credentialFreeUrl(config.api),
    options: baseURL === undefined ? undefined : { baseURL },
  })
}

/** The non-secret view of one model configuration (models.dev or custom). */
export function viewOnlyLlmModelConfig(config: JsonRecord): JsonRecord {
  const modalities = isRecord(config.modalities)
    ? compact({ input: matchingStrings(config.modalities.input, MODALITY), output: matchingStrings(config.modalities.output, MODALITY) })
    : undefined
  return compact({
    id: text(config.id),
    name: text(config.name),
    family: text(config.family),
    status: text(config.status),
    knowledge: text(config.knowledge),
    release_date: text(config.release_date),
    last_updated: text(config.last_updated),
    attachment: flag(config.attachment),
    reasoning: flag(config.reasoning),
    tool_call: flag(config.tool_call),
    temperature: flag(config.temperature),
    open_weights: flag(config.open_weights),
    modalities: modalities && Object.keys(modalities).length > 0 ? modalities : undefined,
    limit: numberRecord(config.limit, ["context", "input", "output"]),
    cost: numberRecord(config.cost, ["input", "output", "cache_read", "cache_write"]),
  })
}
