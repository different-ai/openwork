type JsonRecord = Record<string, unknown>

// View-only callers (no llm_providers.update, not the creator, not granted) get a
// minimal view rebuilt from scratch: what the provider and its models are called,
// the SDK package, and model limits. Nothing else in a stored configuration is
// returned, at any depth: no URLs or hostnames, env names, docs, options or
// headers. Custom providers keep arbitrary fields, so any of those can carry a
// credential.

const MAX_TEXT = 255

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_TEXT ? value : undefined
}

function compact(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function limits(value: unknown): JsonRecord | undefined {
  if (!isRecord(value)) return undefined
  const picked = Object.fromEntries(["context", "input", "output"].flatMap((key) => {
    const entry = value[key]
    return typeof entry === "number" && Number.isFinite(entry) ? [[key, entry]] : []
  }))
  return Object.keys(picked).length > 0 ? picked : undefined
}

/** The view-only provider configuration: id, name and npm package only. */
export function viewOnlyLlmProviderConfig(config: JsonRecord): JsonRecord {
  return compact({ id: text(config.id), name: text(config.name), npm: text(config.npm) })
}

/** The view-only model configuration: id, name and numeric limits only. */
export function viewOnlyLlmModelConfig(config: JsonRecord): JsonRecord {
  return compact({ id: text(config.id), name: text(config.name), limit: limits(config.limit) })
}
