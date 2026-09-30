import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type ModelsDev = typeof import("../src/llm/models-dev.js")

const realFetch = globalThis.fetch
const baseJson = readFileSync(path.resolve(import.meta.dir, "../../gateway/src/models/base.json"), "utf8")

afterEach(() => { globalThis.fetch = realFetch })

function serveCatalog(body: string) {
  globalThis.fetch = Object.assign(async () => new Response(body, { headers: { "content-type": "application/json" } }), { preconnect: realFetch.preconnect })
}

test("Den's hosted catalog exposes the derived Amazon Bedrock (OpenAI) provider next to Amazon Bedrock", async () => {
  serveCatalog(baseJson)
  // A fresh module instance per test: the catalog is cached for ten minutes.
  const { getModelsDevProvider, listModelsDevProviders }: ModelsDev = await import(`../src/llm/models-dev.js?mantle=${Date.now()}`)
  const mantle = await getModelsDevProvider("amazon-bedrock-mantle")
  expect(mantle).toMatchObject({ id: "amazon-bedrock-mantle", name: "Amazon Bedrock (OpenAI)", npm: "@ai-sdk/amazon-bedrock/mantle", env: ["AWS_BEARER_TOKEN_BEDROCK"] })
  expect(mantle?.models).toHaveLength(13)
  expect((await getModelsDevProvider("amazon-bedrock"))?.npm).toBe("@ai-sdk/amazon-bedrock")
  const summaries = await listModelsDevProviders()
  expect(summaries.filter((entry) => entry.id === "amazon-bedrock-mantle")).toHaveLength(1)
})

test("a real upstream amazon-bedrock-mantle entry replaces the derivation", async () => {
  const parsed: unknown = JSON.parse(baseJson)
  if (typeof parsed !== "object" || parsed === null) throw new Error("base.json must be an object")
  serveCatalog(JSON.stringify({ ...parsed, "amazon-bedrock-mantle": { id: "amazon-bedrock-mantle", name: "Upstream Mantle", npm: "@ai-sdk/amazon-bedrock/mantle", env: [], models: { one: { id: "one", name: "One" } } } }))
  const { getModelsDevProvider }: ModelsDev = await import(`../src/llm/models-dev.js?upstream=${Date.now()}`)
  const mantle = await getModelsDevProvider("amazon-bedrock-mantle")
  expect(mantle?.name).toBe("Upstream Mantle")
  expect(mantle?.models.map((model) => model.id)).toEqual(["one"])
})
