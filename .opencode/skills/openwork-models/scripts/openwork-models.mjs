#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const paths = {
  source: path.resolve("ee/apps/inference/src/models/base.json"),
  models: path.resolve("ee/apps/inference/src/models/openwork-models.json"),
  aliases: path.resolve("packages/types/src/den/inference.ts"),
}

function usage() {
  console.log(`Usage:
  openwork-models.mjs search <query>
  openwork-models.mjs add <query-or-id>
  openwork-models.mjs remove <id> [<id2>]
  openwork-models.mjs discount <usageFactor> <id> [<id2>]
  openwork-models.mjs sync
  openwork-models.mjs validate`)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function terms(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((term) => normalize(term))
    .filter(Boolean)
}

function modelText(id, model) {
  return `${id} ${model.id ?? ""} ${model.name ?? ""} ${model.family ?? ""}`
}

function scoreModel(query, id, model) {
  const compactQuery = normalize(query)
  const compactText = normalize(modelText(id, model))
  if (!compactQuery) return 0
  if (id === query || model.id === query) return 1_000
  if (compactText.includes(compactQuery)) return 200 + compactQuery.length

  const queryTerms = terms(query)
  let score = 0
  for (const term of queryTerms) {
    if (compactText.includes(term)) score += 20 + term.length
  }
  return score
}

function displayMatches(matches) {
  for (const match of matches.slice(0, 12)) {
    console.log(`${match.id}\t${match.model.name ?? ""}`)
  }
}

async function readSourceModels() {
  const base = await readJson(paths.source)
  const sourceModels = base?.openrouter?.models
  if (!isRecord(sourceModels)) {
    throw new Error(`${paths.source} did not contain openrouter.models`)
  }
  return sourceModels
}

async function readOpenworkModels() {
  const models = await readJson(paths.models)
  if (!isRecord(models)) {
    throw new Error(`${paths.models} must be a JSON object keyed by model id`)
  }
  return models
}

function findMatches(sourceModels, query) {
  return Object.entries(sourceModels)
    .map(([id, model]) => ({ id, model, score: scoreModel(query, id, model) }))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
}

function resolveSingleSourceModel(sourceModels, query) {
  if (sourceModels[query]) {
    return { id: query, model: sourceModels[query] }
  }

  const matches = findMatches(sourceModels, query)
  if (matches.length === 0) {
    console.error(`No source model matched "${query}".`)
    process.exitCode = 2
    return null
  }

  const [first, second] = matches
  if (first && first.score >= 40 && (!second || first.score - second.score >= 10)) {
    return { id: first.id, model: first.model }
  }

  console.error(`Multiple source models matched "${query}". Please clarify with exact id:`)
  displayMatches(matches)
  process.exitCode = 2
  return null
}

function resolveExactOpenworkIds(openworkModels, ids) {
  const resolved = []
  for (const id of ids) {
    if (openworkModels[id]) {
      resolved.push(id)
      continue
    }

    const matches = findMatches(openworkModels, id)
    console.error(`OpenWork model "${id}" was not exact. Please clarify with exact id:`)
    displayMatches(matches)
    process.exitCode = 2
    return null
  }
  return resolved
}

function escapeTsString(value) {
  return JSON.stringify(value)
}

async function readUsageFactors() {
  const source = await readFile(paths.aliases, "utf8")
  const factors = new Map()
  const pattern = /"([^"]+)":\s*\{[\s\S]*?usageFactor:\s*([0-9.]+)/g
  for (const match of source.matchAll(pattern)) {
    factors.set(match[1], Number(match[2]))
  }
  return factors
}

async function syncAliases(models, usageOverrides = new Map()) {
  const source = await readFile(paths.aliases, "utf8")
  const existingFactors = await readUsageFactors()
  const entries = Object.entries(models).map(([id, model]) => {
    const usageFactor = usageOverrides.get(id) ?? existingFactors.get(id) ?? 1
    const displayName = `OpenWork: ${model.name}`
    return `  ${escapeTsString(id)}: {
    upstreamModel: ${escapeTsString(id)},
    displayName: ${escapeTsString(displayName)},
    enabled: true,
    usageFactor: ${usageFactor},
  },`
  })

  const replacement = `export const INFERENCE_MODEL_ALIASES = {\n${entries.join("\n")}\n} as const;`
  const aliasesPattern = /export const INFERENCE_MODEL_ALIASES = \{[\s\S]*?\n\} as const;/
  if (!aliasesPattern.test(source)) {
    throw new Error(`Could not find INFERENCE_MODEL_ALIASES in ${paths.aliases}`)
  }

  const nextSource = source.replace(aliasesPattern, replacement)

  await writeFile(paths.aliases, nextSource)
}

async function syncAll(models, usageOverrides = new Map()) {
  await writeJson(paths.models, models)
  await syncAliases(models, usageOverrides)
  await validate()
}

async function validate() {
  const models = await readOpenworkModels()
  for (const [id, model] of Object.entries(models)) {
    if (!isRecord(model)) throw new Error(`${id} must be an object`)
    if (model.id !== id) throw new Error(`${id} must have matching id field`)
    if (typeof model.name !== "string" || model.name.length === 0) {
      throw new Error(`${id} must have a name`)
    }
    if (typeof model.family !== "string" || model.family.length === 0) {
      throw new Error(`${id} must have a family`)
    }
    if (!isRecord(model.cost)) {
      throw new Error(`${id} must have a cost object`)
    }
  }

  const aliasSource = await readFile(paths.aliases, "utf8")
  for (const id of Object.keys(models)) {
    if (!aliasSource.includes(`upstreamModel: ${escapeTsString(id)}`)) {
      throw new Error(`${id} is missing from INFERENCE_MODEL_ALIASES`)
    }
  }

  const aliasKeys = [...aliasSource.matchAll(/^\s*"([^"]+)": \{/gm)].map((match) => match[1])
  for (const aliasKey of aliasKeys) {
    if (!models[aliasKey]) {
      throw new Error(`${aliasKey} exists in INFERENCE_MODEL_ALIASES but not ${paths.models}`)
    }
  }

  console.log(`validated ${Object.keys(models).length} OpenWork model(s)`)
}

async function search(query) {
  const sourceModels = await readSourceModels()
  const matches = findMatches(sourceModels, query)
  if (matches.length === 0) {
    console.log(`No source models matched "${query}".`)
    return
  }
  displayMatches(matches)
}

async function add(query) {
  const sourceModels = await readSourceModels()
  const selected = resolveSingleSourceModel(sourceModels, query)
  if (!selected) return

  const models = await readOpenworkModels()
  models[selected.id] = selected.model
  await syncAll(models)
  console.log(`added ${selected.id}`)
}

async function remove(ids) {
  const models = await readOpenworkModels()
  const resolved = resolveExactOpenworkIds(models, ids)
  if (!resolved) return

  for (const id of resolved) {
    delete models[id]
  }
  await syncAll(models)
  console.log(`removed ${resolved.join(", ")}`)
}

async function discount(factorText, ids) {
  const factor = Number(factorText)
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("usageFactor must be a positive number")
  }

  const models = await readOpenworkModels()
  const resolved = resolveExactOpenworkIds(models, ids)
  if (!resolved) return

  const currentFactors = await readUsageFactors()
  for (const id of resolved) {
    currentFactors.set(id, factor)
  }

  await syncAll(models, currentFactors)
  console.log(`set usageFactor=${factor} for ${resolved.join(", ")}`)
}

const [command, ...args] = process.argv.slice(2)

if (!command) {
  usage()
  process.exit(1)
}

if (command === "search") {
  await search(args.join(" "))
} else if (command === "add") {
  await add(args.join(" "))
} else if (command === "remove") {
  await remove(args)
} else if (command === "discount") {
  await discount(args[0], args.slice(1))
} else if (command === "sync") {
  await syncAll(await readOpenworkModels())
} else if (command === "validate") {
  await validate()
} else {
  usage()
  process.exit(1)
}
