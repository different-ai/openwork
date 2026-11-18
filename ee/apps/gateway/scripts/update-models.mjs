// Refreshes src/models/base.json (models.dev /api.json, v1 shape) and
// src/models/base-v2.json (models.dev /experimental/v2.0/api.json, v2 shape)
// in one run so both describe the same models.dev deploy: downloads each,
// validates it, adds derived providers (OpenRouter EU), and writes it as
// minified JSON. Called by .github/workflows/update-models.yml.
//
//   node ee/apps/gateway/scripts/update-models.mjs              # full refresh from models.dev
//   node ee/apps/gateway/scripts/update-models.mjs --skip-download  # re-derive providers on the current files
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const modelsPath = process.env.MODELS_PATH
  ? path.resolve(process.env.MODELS_PATH)
  : path.join(appDir, "src", "models", "base.json")
const modelsUrl = process.env.MODELS_URL ?? "https://models.dev/api.json"
const modelsV2Path = process.env.MODELS_V2_PATH
  ? path.resolve(process.env.MODELS_V2_PATH)
  : path.join(appDir, "src", "models", "base-v2.json")
// Every model type, as models.dev serves the v2 path by default. The published
// file is static, so it cannot filter by `?type=`; OpenCode keeps the types it
// uses itself.
const modelsV2Url = process.env.MODELS_V2_URL ?? "https://models.dev/experimental/v2.0/api.json?type=all"
const openRouterEuModelsUrl = "https://openrouter.ai/api/frontend/v1/models/find?active=true&fmt=cards&region=eu"
const skipDownload = process.argv.includes("--skip-download")

function fail(message) {
  throw new Error(`Refusing to update the models snapshot: ${message}`)
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

const V2_MODEL_TYPES = ["chat", "image", "video", "embedding", "reranking", "decision", "transcription", "speech", "realtime", "extraction", "audio"]

function validateModelV2(providerId, modelId, model) {
  const where = `v2 model ${providerId}.${modelId}`
  if (!isRecord(model)) fail(`${where} was not an object`)
  if (model.id !== modelId) fail(`${where} was missing a matching id`)
  if (typeof model.name !== "string" || model.name.length === 0) fail(`${where} was missing a name`)
  // New types are added upstream over time; OpenCode skips the ones it does not use.
  if (typeof model.type !== "string" || model.type.length === 0) fail(`${where} was missing a type`)
  if (!isRecord(model.modalities) || !isStringArray(model.modalities.input) || !isStringArray(model.modalities.output)) {
    fail(`${where} was missing modalities`)
  }
  if (!isRecord(model.capabilities)) fail(`${where} was missing capabilities`)
  if (!isRecord(model.api) || Object.keys(model.api).length === 0) fail(`${where} did not list an API`)
}

function validateCatalogV2(catalog) {
  if (!isRecord(catalog)) fail("v2 catalog was not a JSON object")
  const providers = Object.entries(catalog)
  if (providers.length === 0) fail("v2 catalog did not include any providers")
  let chatModels = 0
  for (const [providerId, provider] of providers) {
    if (!isRecord(provider)) fail(`v2 provider ${providerId} was not an object`)
    if (provider.id !== providerId) fail(`v2 provider ${providerId} was missing a matching id`)
    if (typeof provider.name !== "string" || provider.name.length === 0) fail(`v2 provider ${providerId} was missing a name`)
    if (!isStringArray(provider.env)) fail(`v2 provider ${providerId} was missing env`)
    // OpenCode treats a catalog with any provider `npm` as v1 and converts all of it.
    if ("npm" in provider) fail(`v2 provider ${providerId} has a v1 npm field`)
    if (!isRecord(provider.models)) fail(`v2 provider ${providerId} did not include models`)
    for (const [modelId, model] of Object.entries(provider.models)) {
      validateModelV2(providerId, modelId, model)
      if (model.type === "chat") chatModels++
    }
  }
  if (chatModels === 0) fail("v2 catalog did not include any chat models")
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
function withOpenRouterEu(catalog, euSlugs) {
  const openrouter = catalog.openrouter
  if (!isRecord(openrouter) || !isRecord(openrouter.models)) {
    fail("catalog did not include the openrouter provider")
  }

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

  console.log(
    `[gateway] openrouter-eu: ${Object.keys(models).length} of ${euSlugs.length} EU models kept` +
      (dropped.length > 0 ? `, dropped (not in openrouter): ${dropped.join(", ")}` : ""),
  )
  return placeAfterOpenRouter(catalog, openrouterEu)
}

/** Puts `openrouter-eu` right after `openrouter`, replacing an earlier copy. */
function placeAfterOpenRouter(catalog, openrouterEu) {
  const result = {}
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (providerId === "openrouter-eu") continue
    result[providerId] = provider
    if (providerId === "openrouter") result["openrouter-eu"] = openrouterEu
  }
  return result
}

const OPENROUTER_API = "https://openrouter.ai/api/v1"
const OPENROUTER_EU_API = "https://eu.openrouter.ai/api/v1"

/**
 * The v2 `openrouter-eu`: the same EU models as the v1 file (so both list one
 * set), with every API entry on OpenRouter's EU host instead of the global one.
 */
function withOpenRouterEuV2(catalog, euModelIds) {
  const openrouter = catalog.openrouter
  if (!isRecord(openrouter) || !isRecord(openrouter.models)) {
    fail("v2 catalog did not include the openrouter provider")
  }
  const models = {}
  for (const slug of euModelIds) {
    const model = openrouter.models[slug]
    if (!isRecord(model)) continue
    const copy = structuredClone(model)
    for (const entry of Object.values(copy.api)) {
      if (isRecord(entry) && typeof entry.base_url === "string" && entry.base_url.startsWith(OPENROUTER_API)) {
        entry.base_url = OPENROUTER_EU_API + entry.base_url.slice(OPENROUTER_API.length)
      }
    }
    models[slug] = copy
  }
  if (Object.keys(models).length === 0) fail("none of the OpenRouter EU models exist in the v2 openrouter provider")
  return placeAfterOpenRouter(catalog, {
    id: "openrouter-eu",
    name: "OpenRouter EU",
    doc: "https://eu.openrouter.ai/models",
    env: ["OPENROUTER_EU_API_KEY"],
    models,
  })
}

const [source, sourceV2] = skipDownload
  ? [JSON.parse(await readFile(modelsPath, "utf8")), JSON.parse(await readFile(modelsV2Path, "utf8"))]
  : await Promise.all([fetchJson(modelsUrl), fetchJson(modelsV2Url)])
validateCatalog(source)
validateCatalogV2(sourceV2)
const euSlugs = skipDownload && isRecord(source["openrouter-eu"]) && isRecord(source["openrouter-eu"].models)
  ? Object.keys(source["openrouter-eu"].models)
  : await fetchOpenRouterEuSlugs()
const catalog = withOpenRouterEu(source, euSlugs)
validateCatalog(catalog)
const catalogV2 = withOpenRouterEuV2(sourceV2, Object.keys(catalog["openrouter-eu"].models))
validateCatalogV2(catalogV2)

await writeFile(modelsPath, `${JSON.stringify(catalog)}\n`)
console.log(`[gateway] wrote ${path.relative(process.cwd(), modelsPath)} (${Object.keys(catalog).length} providers)`)
await writeFile(modelsV2Path, `${JSON.stringify(catalogV2)}\n`)
console.log(`[gateway] wrote ${path.relative(process.cwd(), modelsV2Path)} (${Object.keys(catalogV2).length} providers)`)
