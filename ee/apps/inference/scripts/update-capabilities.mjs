import { readFile, writeFile } from "node:fs/promises"
import { INFERENCE_MODEL_ALIASES } from "../../../../packages/types/src/den/inference.ts"

// Provider discovery is read-only. Model additions, removals, and usage factors
// remain explicit commercial/catalog policy changes in INFERENCE_MODEL_ALIASES.
const destination = new URL("../../../../packages/types/src/den/inference-capabilities.json", import.meta.url)
const previous = JSON.parse(await readFile(destination, "utf8"))
const source = "https://openrouter.ai/api/v1/models"
const response = await fetch(source, { signal: AbortSignal.timeout(30000) })
if (!response.ok) throw new Error(`Model discovery failed: HTTP ${response.status}`)
const { data } = await response.json()
if (!Array.isArray(data)) throw new Error("Invalid provider model catalog")
const models = {}
function costPerMillion(pricing, field) {
  const raw = pricing?.[field]
  const value = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN
  if (!Number.isFinite(value) || value < 0) throw new Error(`Model pricing lacks a valid ${field} estimate`)
  return Number((value * 1_000_000).toPrecision(12))
}
for (const [alias, policy] of Object.entries(INFERENCE_MODEL_ALIASES)) {
  const model = data.find((candidate) => candidate.id === policy.upstreamModel)
  if (!model) throw new Error(`Model ${alias} is absent upstream; review its availability explicitly`)
  const context = Math.min(model.context_length, model.top_provider?.context_length ?? model.context_length)
  const output = Math.min(context, model.top_provider?.max_completion_tokens)
  if (!Number.isInteger(context) || context <= 0 || !Number.isInteger(output) || output <= 0 || !Array.isArray(model.supported_parameters)) throw new Error(`Model ${alias} has incomplete limits or capabilities`)
  models[alias] = {
    contextTokens: context,
    outputTokens: output,
    inputModalities: model.architecture.input_modalities.filter((modality) => ["text", "image"].includes(modality)),
    outputModalities: ["text"],
    cost: {
      input: costPerMillion(model.pricing, "prompt"),
      output: costPerMillion(model.pricing, "completion"),
      ...(model.pricing?.input_cache_read == null ? {} : { cache_read: costPerMillion(model.pricing, "input_cache_read") }),
      ...(model.pricing?.input_cache_write == null ? {} : { cache_write: costPerMillion(model.pricing, "input_cache_write") }),
    },
    supportedParameters: model.supported_parameters,
    reasoning: {
      mandatory: model.reasoning?.mandatory === true,
      defaultEnabled: model.reasoning?.default_enabled ?? null,
      supportedEfforts: model.reasoning && "supported_efforts" in model.reasoning ? model.reasoning.supported_efforts : [],
      defaultEffort: model.reasoning?.default_effort ?? null,
      supportsTokenBudget: model.reasoning?.supports_max_tokens === true,
    },
    interleaved: previous.models[alias]?.interleaved ?? false,
  }
}
await writeFile(destination, `${JSON.stringify({ source, verifiedAt: new Date().toISOString(), models }, null, 2)}\n`)
console.log(`Verified ${Object.keys(models).length} managed models. Review the capability diff before publishing.`)
