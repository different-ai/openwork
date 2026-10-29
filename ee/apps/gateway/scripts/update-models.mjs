// Refreshes src/models/base.json: downloads the models.dev catalog, validates it,
// adds derived providers (OpenRouter EU), and writes it as minified JSON.
// Called by .github/workflows/update-models.yml.
//
//   node ee/apps/gateway/scripts/update-models.mjs              # full refresh from models.dev
//   node ee/apps/gateway/scripts/update-models.mjs --skip-download  # re-derive providers on the current base.json
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const modelsPath = process.env.MODELS_PATH
  ? path.resolve(process.env.MODELS_PATH)
  : path.join(appDir, "src", "models", "base.json")
const modelsUrl = process.env.MODELS_URL ?? "https://models.dev/api.json"
const openRouterEuModelsUrl = "https://openrouter.ai/api/frontend/v1/models/find?active=true&fmt=cards&region=eu"
const skipDownload = process.argv.includes("--skip-download")

function fail(message) {
  throw new Error(`Refusing to update ${path.relative(process.cwd(), modelsPath)}: ${message}`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } })
  if (!response.ok) {
    fail(`GET ${url} returned ${response.status} ${response.statusText}`)
  }
  try {
    return JSON.parse(await response.text())
  } catch (error) {
    fail(`GET ${url}: ${error instanceof Error ? error.message : "response was not valid JSON"}`)
  }
}

function validateModel(providerId, modelId, model) {
  if (!isRecord(model)) fail(`model ${providerId}.${modelId} was not an object`)
  if (model.id !== modelId) fail(`model ${providerId}.${modelId} was missing a matching id`)
  if (typeof model.name !== "string" || model.name.length === 0) {
    fail(`model ${providerId}.${modelId} was missing a name`)
  }
  if (!isRecord(model.modalities)) fail(`model ${providerId}.${modelId} was missing modalities`)
  if (!isStringArray(model.modalities.input) || model.modalities.input.length === 0) {
    fail(`model ${providerId}.${modelId} was missing input modalities`)
  }
  if (!isStringArray(model.modalities.output) || model.modalities.output.length === 0) {
    fail(`model ${providerId}.${modelId} was missing output modalities`)
  }
  if (!isRecord(model.limit)) fail(`model ${providerId}.${modelId} was missing limits`)
}

function validateCatalog(catalog) {
  if (!isRecord(catalog)) fail("catalog was not a JSON object")

  const providers = Object.entries(catalog)
  if (providers.length === 0) fail("catalog did not include any providers")

  for (const [providerId, provider] of providers) {
    if (!isRecord(provider)) fail(`provider ${providerId} was not an object`)
    if (provider.id !== providerId) fail(`provider ${providerId} was missing a matching id`)
    if (typeof provider.name !== "string" || provider.name.length === 0) {
      fail(`provider ${providerId} was missing a name`)
    }
    if (!isRecord(provider.models) || Object.keys(provider.models).length === 0) {
      fail(`provider ${providerId} did not include models`)
    }
    for (const [modelId, model] of Object.entries(provider.models)) {
      validateModel(providerId, modelId, model)
    }
  }
}

/** Slugs of the models OpenRouter serves from its EU region. */
async function fetchOpenRouterEuSlugs() {
  const body = await fetchJson(openRouterEuModelsUrl)
  const models = isRecord(body) && isRecord(body.data) ? body.data.models : null
  if (!Array.isArray(models)) fail(`GET ${openRouterEuModelsUrl} did not include data.models`)
  return models.map((model) => (isRecord(model) ? model.slug : null)).filter((slug) => typeof slug === "string")
}

/**
 * Clones the `openrouter` provider as `openrouter-eu`, keeping only the models
 * OpenRouter serves in the EU. EU slugs missing from `openrouter` are dropped.
 * The new provider is placed right after `openrouter`.
 */
async function withOpenRouterEu(catalog) {
  const openrouter = catalog.openrouter
  if (!isRecord(openrouter) || !isRecord(openrouter.models)) {
    fail("catalog did not include the openrouter provider")
  }

  const euSlugs = await fetchOpenRouterEuSlugs()
  const models = {}
  const dropped = []
  for (const slug of euSlugs) {
    const model = openrouter.models[slug]
    if (model) models[slug] = structuredClone(model)
    else dropped.push(slug)
  }
  if (Object.keys(models).length === 0) {
    fail("none of the OpenRouter EU models exist in the openrouter provider")
  }

  const openrouterEu = {
    id: "openrouter-eu",
    env: ["OPENROUTER_EU_API_KEY"],
    npm: "@openrouter/ai-sdk-provider",
    api: "https://eu.openrouter.ai/api/v1",
    name: "OpenRouter EU",
    doc: "https://eu.openrouter.ai/models",
    models,
  }

  const result = {}
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (providerId === "openrouter-eu") continue
    result[providerId] = provider
    if (providerId === "openrouter") result["openrouter-eu"] = openrouterEu
  }

  console.log(
    `[gateway] openrouter-eu: ${Object.keys(models).length} of ${euSlugs.length} EU models kept` +
      (dropped.length > 0 ? `, dropped (not in openrouter): ${dropped.join(", ")}` : ""),
  )
  return result
}

const source = skipDownload ? JSON.parse(await readFile(modelsPath, "utf8")) : await fetchJson(modelsUrl)
validateCatalog(source)
const catalog = await withOpenRouterEu(source)
validateCatalog(catalog)

await writeFile(modelsPath, `${JSON.stringify(catalog)}\n`)
console.log(`[gateway] wrote ${path.relative(process.cwd(), modelsPath)} (${Object.keys(catalog).length} providers)`)
