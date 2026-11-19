import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  CatalogValidationError,
  CUSTOM_PROVIDER_NPM_PACKAGES,
  readBaseCatalog,
  readCustomProviders,
  readProviderCatalog,
  readPublishedCatalog,
} from "../src/models/catalog.js"
import {
  modelToV2,
  OPENWORK_PROVIDER_DOC,
  readBaseCatalogV2,
  readPublishedCatalogV2,
  V2_ROUTES,
  validateProviderV2,
} from "../src/models/catalog-v2.js"
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

const baseV2 = {
  openai: { id: "openai", name: "OpenAI", doc: "https://platform.openai.com/docs/models", env: ["OPENAI_API_KEY"], models: {} },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    doc: "https://openrouter.ai/models",
    env: ["OPENROUTER_API_KEY"],
    models: { "z-ai/glm-5.2": { id: "z-ai/glm-5.2", type: "chat", family: "glm", description: "GLM from OpenRouter" } },
  },
}

/** A models source folder with base.json, openwork-models.json and the given providers/ files. */
function sourceDir(files: Record<string, unknown> | null) {
  const dir = mkdtempSync(path.join(tmpdir(), "gateway-models-"))
  writeFileSync(path.join(dir, "base.json"), JSON.stringify(base))
  writeFileSync(path.join(dir, "base-v2.json"), JSON.stringify(baseV2))
  writeFileSync(path.join(dir, "openwork-models.json"), JSON.stringify({ "z-ai/glm-5.2": { ...model, id: "z-ai/glm-5.2", name: "GLM-5.2", family: "glm" } }))
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

// ---- v2 catalog (experimental/v2.0/api.json) ----

function modelIds(provider: unknown): string[] {
  const models = typeof provider === "object" && provider !== null && "models" in provider ? provider.models : undefined
  return typeof models === "object" && models !== null ? Object.keys(models).sort() : []
}

test("the committed v2 catalog lists the same OpenWork and custom models as v1, in the v2 shape", () => {
  const api = "https://inference.openworklabs.com/api/v1"
  const v1 = readPublishedCatalog(api)
  const v2 = readPublishedCatalogV2(api)
  const baseV2Ids = Object.keys(readBaseCatalogV2())
  assert.deepEqual(Object.keys(v2).slice(0, baseV2Ids.length), baseV2Ids, "base-v2.json is published first and unchanged in order")
  assert.equal(Object.keys(v2).at(-1), "openwork")

  const ours = [...Object.keys(readCustomProviders(readBaseCatalog())), "openwork"]
  for (const id of ours) {
    assert.deepEqual(modelIds(v2[id]), modelIds(v1[id]), `${id} lists the same models in v1 and v2`)
    assert.deepEqual(validateProviderV2(id, v2[id]), [])
  }
  assert.deepEqual(modelIds(v2["openrouter-eu"]), modelIds(v1["openrouter-eu"]), "openrouter-eu lists the same models in both snapshots")
  assert.equal(v2.openwork.doc, OPENWORK_PROVIDER_DOC)
  // OpenCode reads any provider with `npm` as a sign the whole catalog is v1.
  assert.deepEqual(Object.keys(v2).filter((id) => "npm" in v2[id]), [])
})

test("an OpenWork model converts to the route and fields OpenCode derives from v1", () => {
  const v2 = readPublishedCatalogV2("http://127.0.0.1:8791/api/v1", sourceDir(null))
  const glm = v2.openwork.models
  assert.ok(typeof glm === "object" && glm !== null && "z-ai/glm-5.2" in glm)
  assert.deepEqual(v2.openwork, {
    id: "openwork",
    name: "OpenWork Models",
    doc: OPENWORK_PROVIDER_DOC,
    env: ["OPENWORK_API_KEY"],
    models: {
      "z-ai/glm-5.2": {
        id: "z-ai/glm-5.2",
        type: "chat",
        name: "GLM-5.2",
        description: "GLM from OpenRouter",
        family: "glm",
        open_weights: false,
        release_date: "2026-08-29",
        last_updated: "2026-10-29",
        modalities: { input: ["text"], output: ["text"] },
        capabilities: {
          tools: { supported: true },
          reasoning: { supported: true, toggle: true, effort: ["none", "high", "max"] },
          temperature: true,
          system_updates: false,
          effort_updates: false,
        },
        limit: { context: 131072, output: 32768 },
        cost: { text: { input: { price: 0.2, cache: { read: 0.018 } }, output: { price: 0.64 } } },
        api: {
          "chat-completions": {
            base_url: "http://127.0.0.1:8791/api/v1",
            sdk: { aisdk: "@openrouter/ai-sdk-provider", opencodeai: "@opencode/ai/providers/openrouter" },
            capabilities: { tools: { updates: false } },
          },
        },
      },
    },
  })
})

test("v1 model fields map to their v2 equivalents", () => {
  const converted = modelToV2(
    {
      ...model,
      family: "not-a-models-dev-family",
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
      canonical_model_id: "example/large",
      reasoning_options: [{ type: "budget_tokens", min: 1024 }],
      cost: {
        input: 1, output: 5, cache_read: 0.1, cache_write: 1.25, reasoning: 6,
        tiers: [{ input: 2, output: 7.5, cache_read: 0.2, tier: { type: "context", size: 272000 } }],
      },
    },
    { provider: provider("example"), families: new Set(["glm"]) },
  )
  assert.equal(converted.family, undefined, "a family models.dev does not know is left out")
  assert.equal(converted.description, "Example Large", "the name stands in for a missing description")
  assert.equal(converted.canonical_id, "example/large")
  assert.deepEqual(converted.modalities, { input: ["text", "image", "application/pdf"], output: ["text"] })
  assert.deepEqual(converted.capabilities, {
    tools: { supported: true },
    reasoning: { supported: true, budget: { min: 1024 } },
    temperature: true,
    system_updates: false,
    effort_updates: false,
  })
  assert.deepEqual(converted.cost, {
    text: {
      input: {
        price: 1,
        cache: { read: 0.1, write: 1.25 },
        overrides: [{ when: { context: { gt: 272000 } }, price: 2, cache: { read: 0.2 } }],
      },
      output: { price: 5, reasoning: 6, overrides: [{ when: { context: { gt: 272000 } }, price: 7.5 }] },
    },
  })
  assert.deepEqual(converted.api, {
    "chat-completions": {
      base_url: "https://api.example.com/v1",
      sdk: { aisdk: "@ai-sdk/openai-compatible", opencodeai: "@opencode/ai/providers/openai-compatible" },
      compatibility: { reasoning_field: "reasoning_content" },
      capabilities: { tools: { updates: false } },
    },
  })
})

test("every SDK package a custom provider may use has a v2 route", () => {
  for (const npm of [...CUSTOM_PROVIDER_NPM_PACKAGES, "@openrouter/ai-sdk-provider"]) {
    assert.ok(V2_ROUTES[npm], `${npm} has a v2 route`)
  }
})

test("a custom provider is published in both catalogs, with no SDK package in v2", () => {
  const dir = sourceDir({ "example.json": { example: { ...provider("example"), doc: "https://docs.example.com" } } })
  const v2 = readPublishedCatalogV2("http://127.0.0.1:8791/api/v1", dir)
  assert.deepEqual(Object.keys(v2), ["openai", "openrouter", "example", "openwork"])
  assert.deepEqual(Object.keys(v2.example).sort(), ["doc", "env", "id", "models", "name"])
  assert.equal(v2.example.doc, "https://docs.example.com")
  assert.deepEqual(validateProviderV2("example", v2.example), [])
})

test("a custom provider id already in base-v2.json fails the v2 build", () => {
  const dir = sourceDir({ "openrouter.json": { openrouter: provider("openrouter") } })
  assert.throws(() => readPublishedCatalogV2("http://127.0.0.1:8791/api/v1", dir), (error) =>
    error instanceof CatalogValidationError && error.problems.some((line) => line.includes("already used by base-v2.json")),
  )
})
