/**
 * Facts for TrueFoundry models from the models.dev catalog.
 *
 * TrueFoundry's gateway lists model ids only, as `<provider account>/<model>`
 * (e.g. `openai/gpt-5.5`, `my-anthropic/claude-sonnet-4-5`). The account name is
 * chosen by the TrueFoundry admin, but it usually names the vendor, so the
 * catalog is searched in priority order:
 *
 *   1. providers the account name points at (`openai`, `azure-openai` -> azure, openai, ...)
 *   2. the major first-party vendors
 *   3. OpenRouter, whose ids carry the vendor too
 *   4. every other provider, alphabetically
 *
 * and the first provider with a single matching model wins. Within a provider
 * a model matches by exact id, then by its last path segment, then ignoring
 * case and `-_.:`, then also ignoring a trailing date (`-2026-04-23`, `-20250514`).
 * An ambiguous match inside one provider is skipped, never guessed.
 *
 * Only capabilities, modalities and limits are copied. Prices are left out:
 * TrueFoundry budgets these requests and OpenWork does not price them.
 */
import type { ModelsDevModel, ModelsDevProvider } from "./models-dev.js"

type JsonRecord = Record<string, unknown>

/** Searched after the account name's own providers, before everything else. */
export const TRUEFOUNDRY_PRIORITY_PROVIDERS: readonly string[] = [
  "openai", "anthropic", "google", "xai", "mistral", "deepseek", "groq", "cohere", "perplexity",
  "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "azure", "togetherai", "fireworks-ai",
  "openrouter",
]

/** Account-name words that point at catalog providers. */
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

const COPIED_FACTS = ["attachment", "reasoning", "tool_call", "structured_output", "temperature", "modalities", "limit"] as const

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

/** `openai/gpt-5.5` -> account `openai`, model `gpt-5.5`. An id without `/` has no account. */
export function splitTrueFoundryModelId(id: string): { account: string | null; model: string } {
  const slash = id.indexOf("/")
  return slash > 0 ? { account: id.slice(0, slash), model: id.slice(slash + 1) } : { account: null, model: id }
}

/** Catalog provider ids in the order a TrueFoundry model is looked up. */
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

/** The single model in one provider that `name` refers to, or null when none or several do. */
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
    // A looser step only widens the candidates, so an ambiguous match stays ambiguous.
    if (found.length > 1) return null
  }
  return null
}

/** The catalog model a TrueFoundry model id refers to, searched provider by provider. */
export function matchTrueFoundryModel(id: string, providers: readonly ModelsDevProvider[]): { provider: ModelsDevProvider; model: ModelsDevModel } | null {
  const { account, model } = splitTrueFoundryModelId(id)
  if (!model) return null
  const byId = new Map(providers.map((provider) => [provider.id, provider]))
  for (const providerId of trueFoundrySearchOrder(account, providers)) {
    const provider = byId.get(providerId)
    if (!provider) continue
    // Ids that keep the account prefix (OpenRouter's `openai/gpt-5.5`) can match whole.
    const found = matchInProvider(model, provider.models) ?? (account ? provider.models.find((entry) => entry.id === id) ?? null : null)
    if (found) return { provider, model: found }
  }
  return null
}

/** OpenWork model config for a TrueFoundry model: its own id, the match's name and copied facts. */
export function trueFoundryModelConfig(id: string, match: { provider: ModelsDevProvider; model: ModelsDevModel } | null): JsonRecord {
  // Unmatched models still need tools for OpenWork agents; TrueFoundry's chat API carries OpenAI tool calls.
  if (!match) return { id, name: id, tool_call: true, modalities: { input: ["text"], output: ["text"] } }
  const facts = Object.fromEntries(COPIED_FACTS.flatMap((key) => match.model.config[key] === undefined ? [] : [[key, match.model.config[key]]]))
  return { tool_call: true, modalities: { input: ["text"], output: ["text"] }, ...facts, id, name: match.model.name }
}
