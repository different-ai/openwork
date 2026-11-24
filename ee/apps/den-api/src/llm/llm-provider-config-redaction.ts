type JsonRecord = Record<string, unknown>

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

export function viewOnlyLlmProviderConfig(config: JsonRecord): JsonRecord {
  return compact({ id: text(config.id), name: text(config.name), npm: text(config.npm) })
}

export function viewOnlyLlmModelConfig(config: JsonRecord): JsonRecord {
  return compact({ id: text(config.id), name: text(config.name), limit: limits(config.limit) })
}
