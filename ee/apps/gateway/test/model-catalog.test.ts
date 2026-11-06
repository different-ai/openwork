import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  CatalogValidationError,
  readBaseCatalog,
  readCustomProviders,
  readProviderCatalog,
  readPublishedCatalog,
} from "../src/models/catalog.js"
import { createPricingCatalog } from "../src/pricing.js"
import { createProviderCatalog } from "../src/provider-catalog.js"

const model = {
  id: "example-large",
  name: "Example Large",
  attachment: false,
  reasoning: true,
  reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["none", "high", "max"] }],
  tool_call: true,
  temperature: true,
  release_date: "2026-08-29",
  last_updated: "2026-10-29",
  modalities: { input: ["text"], output: ["text"] },
  limit: { context: 131072, output: 32768 },
  cost: { input: 0.2, output: 0.64, cache_read: 0.018 },
}

function provider(id: string, models: Record<string, unknown> = { "example-large": model }) {
  return { id, name: "Example AI", env: ["EXAMPLE_API_KEY"], npm: "@ai-sdk/openai-compatible", api: "https://api.example.com/v1", models }
}

const base = {
  openai: { id: "openai", name: "OpenAI", npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"], models: {} },
}

/** A models source folder with base.json, openwork-models.json and the given providers/ files. */
function sourceDir(files: Record<string, unknown> | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "gateway-models-"))
  writeFileSync(path.join(dir, "base.json"), JSON.stringify(base))
  writeFileSync(path.join(dir, "openwork-models.json"), JSON.stringify({ "z-ai/glm-5.2": { id: "z-ai/glm-5.2", name: "GLM-5.2" } }))
  if (files) {
    mkdirSync(path.join(dir, "providers"))
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(path.join(dir, "providers", name), typeof contents === "string" ? contents : JSON.stringify(contents))
    }
  }
  return dir
}

function problems(dir: string): readonly string[] {
  try {
    readProviderCatalog(dir)
  } catch (error) {
    if (error instanceof CatalogValidationError) return error.problems
    throw error
  }
  return []
}

test("every committed provider file is valid and merged after base.json", () => {
  const catalog = readProviderCatalog()
  const baseIds = Object.keys(readBaseCatalog())
  assert.deepEqual(Object.keys(catalog).slice(0, baseIds.length), baseIds)
  assert.equal(catalog.openwork, undefined, "the gateway catalog does not include the OpenWork provider")

  const published = readPublishedCatalog("https://inference.openworklabs.com/api/v1")
  assert.equal(Object.keys(published).at(-1), "openwork")
  assert.equal(published.openwork.api, "https://inference.openworklabs.com/api/v1")
})

test("custom providers merge after base.json in file-name order", () => {
  const dir = sourceDir({ "zeta.json": { zeta: provider("zeta") }, "alpha.json": { alpha: provider("alpha") }, "notes.txt": "ignored" })
  assert.deepEqual(Object.keys(readProviderCatalog(dir)), ["openai", "alpha", "zeta"])
  assert.deepEqual(Object.keys(readPublishedCatalog("http://127.0.0.1:8791/api/v1", dir)), ["openai", "alpha", "zeta", "openwork"])
})

test("a missing providers folder adds nothing", () => {
  const dir = sourceDir(null)
  assert.deepEqual(readCustomProviders(readBaseCatalog(dir), dir), {})
})

test("a custom provider is priced and routed by the gateway", () => {
  const catalog = readProviderCatalog(sourceDir({ "example.json": { example: provider("example") } }))
  assert.deepEqual(createPricingCatalog(catalog).getModelPrice("example", "example-large"), {
    input: 0.2, output: 0.64, cacheRead: 0.018, cacheWrite: null, reasoning: null, contextTiers: [],
  })
  const routed = createProviderCatalog(catalog).getCatalogProvider("example")
  assert.equal(routed?.npm, "@ai-sdk/openai-compatible")
  assert.equal(routed?.api, "https://api.example.com/v1")
  assert.deepEqual(routed?.env, ["EXAMPLE_API_KEY"])
})

test("provider ids cannot clash with base.json, other files or reserved ids", () => {
  const found = problems(sourceDir({
    "a.json": { openai: provider("openai"), example: provider("example") },
    "b.json": { example: provider("example") },
    "c.json": { openwork: provider("openwork"), "Bad_Id": provider("Bad_Id") },
  }))
  assert.ok(found.some((line) => line.startsWith("providers/a.json › openai:") && line.includes("already used")))
  assert.ok(found.some((line) => line.startsWith("providers/b.json › example:") && line.includes("already used")))
  assert.ok(found.some((line) => line.startsWith("providers/c.json › openwork:") && line.includes("reserved")))
  assert.ok(found.some((line) => line.startsWith("providers/c.json › Bad_Id:") && line.includes("lowercase")))
})

test("provider fields are checked", () => {
  const found = problems(sourceDir({
    "bad.json": { bad: { ...provider("bad"), id: "other", env: [], npm: "@ai-sdk/amazon-bedrock", api: "http://api.example.com" } },
  }))
  for (const expected of ["id must equal", "env must list", "npm must be one of", "api must be an https:// URL"]) {
    assert.ok(found.some((line) => line.includes(expected)), `expected a problem containing "${expected}" in ${found.join("; ")}`)
  }
})

test("model fields are checked", () => {
  const { limit: _limit, cost: _cost, ...withoutLimitOrCost } = model
  const found = problems(sourceDir({
    "bad.json": {
      bad: provider("bad", {
        "no-limit": { ...withoutLimitOrCost, id: "no-limit" },
        "bad-effort": { ...model, id: "bad-effort", reasoning_options: [{ type: "effort", values: ["turbo"] }] },
        "big-output": { ...model, id: "big-output", limit: { context: 1000, output: 2000 } },
        "no-flags": { ...model, id: "no-flags", tool_call: "yes", release_date: "soon" },
      }),
    },
  }))
  for (const expected of [
    "no-limit: limit.context and limit.output",
    "no-limit: cost.input and cost.output are required",
    'bad-effort: effort value "turbo"',
    "big-output: limit.output cannot exceed limit.context",
    "no-flags: tool_call must be true or false",
    "no-flags: release_date must be YYYY-MM-DD",
  ]) {
    assert.ok(found.some((line) => line.endsWith(expected) || line.includes(expected)), `expected "${expected}" in ${found.join("; ")}`)
  }
})

test("a deprecated model may omit cost", () => {
  const { cost: _cost, ...withoutCost } = model
  const dir = sourceDir({ "example.json": { example: provider("example", { old: { ...withoutCost, id: "old", status: "deprecated" } }) } })
  assert.deepEqual(problems(dir), [])
})

test("invalid JSON fails with the file name", () => {
  const found = problems(sourceDir({ "broken.json": "{ not json" }))
  assert.equal(found.length, 1)
  assert.ok(found[0].startsWith("providers/broken.json:"))
})
