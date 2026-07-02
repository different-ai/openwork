#!/usr/bin/env node
import { writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const basePath = path.resolve("ee/apps/inference/src/models/base.json")

function readFlag(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return null
  return process.argv[index + 1] ?? null
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

function scoreModel(query, id, model) {
  const compactQuery = normalize(query)
  const haystack = normalize(`${id} ${model.name ?? ""} ${model.family ?? ""}`)
  const queryTerms = terms(query)
  if (!compactQuery) return 0
  if (id === query || model.id === query) return 1_000
  if (haystack.includes(compactQuery)) return 200 + compactQuery.length

  return queryTerms.reduce((score, term) => score + (haystack.includes(term) ? 20 + term.length : 0), 0)
}

const query = readFlag("--query")
const outPath = readFlag("--out") ?? path.join(os.tmpdir(), `openwork-openrouter-models-${Date.now()}.json`)
const base = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(basePath, "utf8")))
const sourceModels = base?.openrouter?.models

if (!sourceModels || typeof sourceModels !== "object" || Array.isArray(sourceModels)) {
  throw new Error(`${basePath} did not contain openrouter.models`)
}

const entries = Object.entries(sourceModels)
const selectedEntries = query
  ? entries
      .map(([id, model]) => ({ id, model, score: scoreModel(query, id, model) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, 25)
      .map((entry) => [entry.id, entry.model])
  : entries

const models = Object.fromEntries(selectedEntries)
await writeFile(outPath, `${JSON.stringify(models, null, 2)}\n`)

console.log(`wrote ${selectedEntries.length} model(s) to ${outPath}`)
if (query) {
  for (const [id, model] of selectedEntries.slice(0, 10)) {
    console.log(`${id}\t${model.name ?? ""}`)
  }
}
