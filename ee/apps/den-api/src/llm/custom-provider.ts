import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"

type JsonRecord = Record<string, unknown>

export type NormalizedCustomProvider = {
  providerId: string
  providerConfig: JsonRecord
  models: Array<{
    id: string
    name: string
    config: JsonRecord
  }>
}

export class CustomProviderConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CustomProviderConfigError"
  }
}

const customModelSchema = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
}).passthrough()

const customProviderSchema = z.object({
  id: z.string().trim().min(1).max(255),
  name: z.string().trim().min(1).max(255),
  npm: z.string().trim().min(1).max(255),
  env: z.array(z.string().trim().min(1).max(255)).min(1),
  doc: z.string().trim().min(1).max(2048).optional(),
  api: z.string().trim().min(1).max(2048).optional(),
  models: z.array(customModelSchema).min(1),
}).passthrough()

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseCustomProviderText(text: string) {
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new CustomProviderConfigError("Custom provider config must be valid JSON or JSONC.")
  }
  return parsed
}

function unwrapOpencodeProviderConfig(value: unknown) {
  if (!isRecord(value) || !isRecord(value.provider)) {
    return value
  }

  const providers = Object.entries(value.provider).filter((entry): entry is [string, JsonRecord] => isRecord(entry[1]))
  if (providers.length === 1) {
    return providers[0][1]
  }

  if (providers.length === 0) {
    throw new CustomProviderConfigError("provider must contain one provider block.")
  }

  throw new CustomProviderConfigError("Custom provider config contains multiple providers. Paste one provider block or remove the others.")
}

function normalizeModelArray(models: unknown[]) {
  return models.map((model) => {
    if (typeof model === "string") {
      return { id: model, name: model }
    }
    return model
  })
}

function normalizeModelMap(models: JsonRecord) {
  return Object.entries(models).map(([modelId, model]) => {
    if (!isRecord(model)) {
      return { id: modelId, name: modelId }
    }

    return {
      ...model,
      id: readString(model.id) ?? modelId,
      name: readString(model.name) ?? modelId,
    }
  })
}

function normalizeModels(value: unknown) {
  if (Array.isArray(value)) {
    return normalizeModelArray(value)
  }

  if (isRecord(value)) {
    return normalizeModelMap(value)
  }

  return value
}

function normalizeProviderShape(value: unknown) {
  const provider = unwrapOpencodeProviderConfig(value)
  if (!isRecord(provider)) {
    return provider
  }

  return {
    ...provider,
    models: normalizeModels(provider.models),
  }
}

function formatIssuePath(path: PropertyKey[]) {
  return path.length > 0 ? path.map((part) => String(part)).join(".") : "config"
}

function formatZodIssues(error: z.ZodError) {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
    .join("; ")
}

export function normalizeCustomProviderConfig(input: {
  customConfigText?: string
  customConfig?: unknown
}): NormalizedCustomProvider {
  const rawConfig = input.customConfigText !== undefined
    ? parseCustomProviderText(input.customConfigText)
    : input.customConfig

  const normalizedConfig = normalizeProviderShape(rawConfig)
  const customProvider = customProviderSchema.safeParse(normalizedConfig)
  if (!customProvider.success) {
    throw new CustomProviderConfigError(formatZodIssues(customProvider.error) || "Custom provider config is invalid.")
  }

  const { models, ...providerConfig } = customProvider.data

  return {
    providerId: customProvider.data.id,
    providerConfig,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      config: model,
    })),
  }
}
