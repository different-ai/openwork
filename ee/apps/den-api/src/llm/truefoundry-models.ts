import type { ModelsDevModel, ModelsDevProvider } from "./models-dev.js"

type JsonRecord = Record<string, unknown>

export const TRUEFOUNDRY_PRIORITY_PROVIDERS: readonly string[] = [
  "openai", "anthropic", "google", "xai", "mistral", "deepseek", "groq", "cohere", "perplexity",
  "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "azure", "togetherai", "fireworks-ai",
  "openrouter",
]

const ACCOUNT_HINTS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/azure/, ["azure", "openai"]],
  [/openai|gpt/, ["openai"]],
  [/anthropic|claude/, ["anthropic"]],
  [/vertex/, ["google-vertex", "google-vertex-anthropic", "google"]],
  [/google|gemini/, ["google", "google-vertex"]],
  [/bedrock|aws/, ["amazon-bedrock", "anthropic"]],
  [/mistral/, ["mistral"]],
  [/xai|grok/, ["xai"]],
  [/deepseek/, ["deepseek"]],
  [/groq/, ["groq"]],
  [/together/, ["togetherai"]],
  [/fireworks/, ["fireworks-ai"]],
  [/cohere/, ["cohere"]],
  [/perplexity|sonar/, ["perplexity"]],
]

const COPIED_FACTS = ["attachment", "reasoning", "reasoning_options", "tool_call", "structured_output", "temperature", "modalities", "limit"] as const
const PRICE_FACTS = ["cost"] as const

export type TrueFoundryModelMatch = { providerId: string; modelId: string }

function lastSegment(id: string) {
  return id.slice(id.lastIndexOf("/") + 1)
}

function loose(value: string) {
  return value.toLowerCase().replace(/[-_.:]/g, "")
}

function withoutDate(value: string) {
  return value.replace(/[-_@](?:\d{4}-\d{2}-\d{2}|\d{8})$/, "")
}

export function splitTrueFoundryModelId(id: string): { account: string | null; model: string } {
  const slash = id.indexOf("/")
  return slash > 0 ? { account: id.slice(0, slash), model: id.slice(slash + 1) } : { account: null, model: id }
}

export function trueFoundrySearchOrder(account: string | null, providers: readonly Pick<ModelsDevProvider, "id">[]): string[] {
  const known = new Set(providers.map((provider) => provider.id))
  const hinted: string[] = []
  if (account) {
    const name = account.toLowerCase()
    if (known.has(name)) hinted.push(name)
    for (const [pattern, ids] of ACCOUNT_HINTS) if (pattern.test(name)) hinted.push(...ids)
  }
  const rest = providers.map((provider) => provider.id).sort()
  return [...new Set([...hinted, ...TRUEFOUNDRY_PRIORITY_PROVIDERS, ...rest])].filter((id) => known.has(id))
}

export function matchInProvider(name: string, models: readonly ModelsDevModel[]): ModelsDevModel | null {
  const steps: Array<(model: ModelsDevModel) => boolean> = [
    (model) => model.id === name,
    (model) => lastSegment(model.id) === lastSegment(name),
    (model) => loose(lastSegment(model.id)) === loose(lastSegment(name)),
    (model) => loose(withoutDate(lastSegment(model.id))) === loose(withoutDate(lastSegment(name))),
  ]
  for (const step of steps) {
    const found = models.filter(step)
    if (found.length === 1) return found[0] ?? null
    if (found.length > 1) return null
  }
  return null
}

export function matchTrueFoundryModel(id: string, providers: readonly ModelsDevProvider[]): { provider: ModelsDevProvider; model: ModelsDevModel } | null {
  const { account, model } = splitTrueFoundryModelId(id)
  if (!model) return null
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  for (const providerId of trueFoundrySearchOrder(account, providers)) {
    const provider = byId.get(providerId)
    if (!provider) continue
    const found = matchInProvider(model, provider.models) ?? (account ? provider.models.find((entry) => entry.id === id) ?? null : null)
    if (found) return { provider, model: found }
  }
  return null
}

export function trueFoundryModelConfig(id: string, match: { provider: ModelsDevProvider; model: ModelsDevModel } | null): JsonRecord {
  if (!match) return { id, name: id, tool_call: true, modalities: { input: ["text"], output: ["text"] } }
  const facts = Object.fromEntries([...COPIED_FACTS, ...PRICE_FACTS].flatMap((key) => match.model.config[key] === undefined ? [] : [[key, match.model.config[key]]]))
  return { tool_call: true, modalities: { input: ["text"], output: ["text"] }, ...facts, id, name: match.model.name }
}

export function servedTrueFoundryModel<T extends { config: JsonRecord }>(model: T, trackUsageCosts: boolean): T {
  if (trackUsageCosts) return model
  const config = Object.fromEntries(Object.entries(model.config).filter(([key]) => !PRICE_FACTS.some((price) => price === key)))
  return { ...model, config }
}
