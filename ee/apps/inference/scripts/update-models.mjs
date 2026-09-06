import { appendFile, readFile, writeFile } from "node:fs/promises"

import { isDeepStrictEqual } from "node:util"

const modelsPath = process.env.MODELS_PATH
const modelsUrl = process.env.MODELS_URL

function fail(message) {
  throw new Error(`Refusing to update ${modelsPath}: ${message}`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function validateModel(providerId, modelId, model) {
  if (!isRecord(model)) {
    fail(`model ${providerId}.${modelId} was not an object`)
  }

  if (model.id !== modelId) {
    fail(`model ${providerId}.${modelId} was missing a matching id`)
  }

  if (typeof model.name !== "string" || model.name.length === 0) {
    fail(`model ${providerId}.${modelId} was missing a name`)
  }

  if (!isRecord(model.modalities)) {
    fail(`model ${providerId}.${modelId} was missing modalities`)
  }

  if (!isStringArray(model.modalities.input) || model.modalities.input.length === 0) {
    fail(`model ${providerId}.${modelId} was missing input modalities`)
  }

  if (!isStringArray(model.modalities.output) || model.modalities.output.length === 0) {
    fail(`model ${providerId}.${modelId} was missing output modalities`)
  }

  if (!isRecord(model.limit)) {
    fail(`model ${providerId}.${modelId} was missing limits`)
  }
}

const response = await fetch(modelsUrl, {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(30_000),
})

if (!response.ok) {
  fail(`GET ${modelsUrl} returned ${response.status} ${response.statusText}`)
}

const body = await response.text()
let parsed
try {
  parsed = JSON.parse(body)
} catch (error) {
  fail(error instanceof Error ? error.message : "response was not valid JSON")
}

if (!isRecord(parsed)) {
  fail("response was not a JSON object")
}

const providers = Object.entries(parsed)
if (providers.length === 0) {
  fail("response did not include any providers")
}

for (const [providerId, provider] of providers) {
  if (!isRecord(provider)) {
    fail(`provider ${providerId} was not an object`)
  }

  if (provider.id !== providerId) {
    fail(`provider ${providerId} was missing a matching id`)
  }

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

// Catalog routing controls where credentials are sent. Unattended refreshes
// may update model metadata, but new providers or changed routing need review.
function sameRouting(previous, next) {
  if (!isRecord(previous)) return false
  if (!isDeepStrictEqual(Object.keys(previous).sort(), Object.keys(next).sort())) return false
  for (const [id, provider] of Object.entries(next)) {
    const old = previous[id]
    if (!isRecord(old) || !isRecord(old.models)) return false
    const { models: _oldModels, ...oldProvider } = old
    const { models: _newModels, ...newProvider } = provider
    if (!isDeepStrictEqual(oldProvider, newProvider)) return false
    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!isDeepStrictEqual(old.models[modelId]?.provider, model.provider)) return false
    }
  }
  return true
}

let previous
try {
  previous = JSON.parse(await readFile(modelsPath, "utf8"))
} catch {
  // Without a trusted baseline, require review of the proposed snapshot.
}
const safeToApprove = sameRouting(previous, parsed)
await writeFile(modelsPath, `${JSON.stringify(parsed)}\n`)
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `safe_to_approve=${safeToApprove}\n`)
}
