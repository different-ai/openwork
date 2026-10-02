import { afterEach, expect, spyOn, test } from "bun:test"

type ModelsDev = typeof import("../src/llm/models-dev.js")
const realFetch = globalThis.fetch
const realNow = Date.now
let moduleId = 0
const catalog = JSON.stringify({
  anthropic: { id: "anthropic", name: "Anthropic", npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"],
    models: { sonnet: { id: "sonnet", name: "Sonnet" } } },
})

afterEach(() => {
  globalThis.fetch = realFetch
  Date.now = realNow
})

function freshCatalog(): Promise<ModelsDev> {
  return import(`../src/llm/models-dev.js?cache-test=${++moduleId}`)
}

function serve(fetchCatalog: () => Promise<Response>) {
  globalThis.fetch = Object.assign(fetchCatalog, { preconnect: realFetch.preconnect })
}

test("concurrent provider lookups share one cold catalog fetch and reuse the warm result", async () => {
  let reads = 0
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  serve(async () => { reads += 1; await held; return new Response(catalog) })
  const api = await freshCatalog()
  const providers = Array.from({ length: 10 }, () => api.getModelsDevProvider("anthropic"))
  const summaries = api.listModelsDevProviders()
  const several = api.getModelsDevProviders(["anthropic", "anthropic", "missing"])
  expect(reads).toBe(1)
  release()
  expect((await Promise.all(providers)).every((provider) => provider?.models[0]?.id === "sonnet")).toBe(true)
  expect(await summaries).toMatchObject([{ id: "anthropic", modelCount: 1 }])
  expect(await several).toHaveLength(1)
  expect(await api.getModelsDevProvider("missing")).toBeNull()
  await api.getModelsDevProvider("anthropic")
  expect(reads).toBe(1)
})

test("expired catalogs share a refresh without extending the ten-minute freshness interval", async () => {
  const now = realNow()
  const clock = spyOn(Date, "now").mockReturnValue(now)
  try {
    let reads = 0
    serve(async () => { reads += 1; return new Response(catalog) })
    const api = await freshCatalog()
    await api.getModelsDevProvider("anthropic")
    clock.mockReturnValue(now + 600_000 - 1)
    await api.listModelsDevProviders()
    expect(reads).toBe(1)
    clock.mockReturnValue(now + 600_000)
    await Promise.all(Array.from({ length: 10 }, () => api.getModelsDevProvider("anthropic")))
    expect(reads).toBe(2)
  } finally { clock.mockRestore() }
})

for (const failure of ["http", "invalid", "network"]) {
  test(`a shared ${failure} catalog failure reaches every caller and the next request retries`, async () => {
    let reads = 0
    serve(async () => {
      reads += 1
      if (failure === "network") throw new Error("catalog unavailable")
      return failure === "http" ? new Response("unavailable", { status: 503 }) : new Response("[]")
    })
    const api = await freshCatalog()
    const failed = await Promise.allSettled(Array.from({ length: 10 }, () => api.getModelsDevProvider("anthropic")))
    expect(reads).toBe(1)
    expect(failed.every((result) => result.status === "rejected")).toBe(true)
    serve(async () => { reads += 1; return new Response(catalog) })
    expect(await api.getModelsDevProvider("anthropic")).toMatchObject({ id: "anthropic" })
    expect(reads).toBe(2)
  })
}
