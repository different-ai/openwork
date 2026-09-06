import { describe, expect, test } from "bun:test"
import { sandboxProviderConformanceCases } from "./conformance"
import { createFakeProvider, type FakeOperation } from "./fake-provider"

describe("fake provider conformance", () => {
  for (const conformanceCase of sandboxProviderConformanceCases(() => createFakeProvider())) {
    test(conformanceCase.name, conformanceCase.run)
  }

  test("list returns every visible match, applies all query filters, and records operations", async () => {
    const operations: FakeOperation[] = []
    const provider = createFakeProvider({ onOperation: (operation) => { operations.push(operation) } })
    const labels = { "openwork.den.provider": "fake", "openwork.den.worker-id": "wrk_01jz7m8n9p2q3r4s5t6v7w8x9a" }
    const first = provider.fake.seed({ idempotencyKey: "list-first", state: "running", labels })
    const second = provider.fake.seed({ idempotencyKey: "list-second", state: "stopped", labels })
    const foreignWorker = provider.fake.seed({
      idempotencyKey: "list-foreign-worker", state: "running", labels: { ...labels, "openwork.den.worker-id": "wrk_01jz7m8n9p2q3r4s5t6v7w8x9b" },
    })
    const foreignProvider = provider.fake.seed({
      idempotencyKey: "list-foreign-provider", state: "running", labels: { ...labels, "openwork.den.provider": "other" },
    })
    const unlabelled = provider.fake.seed({ idempotencyKey: "list-unlabelled", state: "running" })
    provider.fake.seed({ idempotencyKey: "list-hidden", state: "running", labels, hidden: true })
    provider.fake.seed({ idempotencyKey: "list-missing", state: "missing", labels })

    expect((await provider.list({ labels })).map((handle) => handle.ref.ref.sandboxId)).toEqual([first.id, second.id])
    expect((await provider.list({ idempotencyKey: first.spec.idempotencyKey, labels })).map((handle) => handle.ref.ref.sandboxId)).toEqual([first.id])
    expect(await provider.list({ idempotencyKey: foreignWorker.spec.idempotencyKey, labels })).toEqual([])
    expect(await provider.list({ idempotencyKey: foreignProvider.spec.idempotencyKey, labels })).toEqual([])
    expect(await provider.list({ labels: { ...labels, absent: "required" } })).toEqual([])
    expect((await provider.list({ idempotencyKey: second.spec.idempotencyKey })).map((handle) => handle.ref.ref.sandboxId)).toEqual([second.id])
    expect((await provider.list({})).map((handle) => handle.ref.ref.sandboxId)).toEqual([
      first.id, second.id, foreignWorker.id, foreignProvider.id, unlabelled.id,
    ])
    expect(provider.fake.count("list")).toBe(7)
    expect(provider.fake.count("find")).toBe(0)
    expect(provider.fake.calls[0]).toBe(`list:${JSON.stringify(labels)}`)
    expect(operations.map((operation) => operation.name)).toEqual(Array(7).fill("list"))
    expect(operations.map((operation) => operation.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(operations[1]?.idempotencyKey).toBe(first.spec.idempotencyKey)
  })
})

describe("fake provider with stable endpoints", () => {
  const factory = () => createFakeProvider({ capabilities: { endpointKind: "stable", stopResume: false } })
  for (const conformanceCase of sandboxProviderConformanceCases(factory)) {
    test(conformanceCase.name, conformanceCase.run)
  }
})
