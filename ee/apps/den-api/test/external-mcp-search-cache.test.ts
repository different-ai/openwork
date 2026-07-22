import { describe, expect, test } from "bun:test"
import { createExternalMcpSearchCache } from "../src/mcp/external-mcp-search-cache.js"

describe("external MCP search cache", () => {
  test("serves repeated searches without another load", async () => {
    const cache = createExternalMcpSearchCache<string[]>({ maxEntries: 4, ttlMs: 1_000 })
    let loads = 0
    const load = async () => {
      loads += 1
      return ["send-message"]
    }

    expect(await cache.getOrLoad("shared:slack", load)).toEqual(["send-message"])
    expect(await cache.getOrLoad("shared:slack", load)).toEqual(["send-message"])
    expect(loads).toBe(1)
  })

  test("coalesces concurrent misses", async () => {
    const cache = createExternalMcpSearchCache<string[]>({ maxEntries: 4, ttlMs: 1_000 })
    let loads = 0
    let release = () => undefined
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = async () => {
      loads += 1
      await blocker
      return ["search"]
    }

    const first = cache.getOrLoad("member:linear", load)
    const second = cache.getOrLoad("member:linear", load)
    release()
    expect(await Promise.all([first, second])).toEqual([["search"], ["search"]])
    expect(loads).toBe(1)
  })

  test("expires entries and does not cache failures", async () => {
    let clock = 0
    const cache = createExternalMcpSearchCache<number>({ maxEntries: 4, ttlMs: 10, now: () => clock })
    let loads = 0
    const load = async () => {
      loads += 1
      return loads
    }

    expect(await cache.getOrLoad("key", load)).toBe(1)
    clock = 9
    expect(await cache.getOrLoad("key", load)).toBe(1)
    clock = 10
    expect(await cache.getOrLoad("key", load)).toBe(2)

    await expect(cache.getOrLoad("failure", async () => {
      throw new Error("provider unavailable")
    })).rejects.toThrow("provider unavailable")
    expect(await cache.getOrLoad("failure", load)).toBe(3)
  })

  test("evicts least-recently-used entries at the memory bound", async () => {
    const cache = createExternalMcpSearchCache<string>({ maxEntries: 2, ttlMs: 1_000 })
    let loads = 0
    const load = async (value: string) => {
      loads += 1
      return value
    }

    await cache.getOrLoad("a", () => load("a"))
    await cache.getOrLoad("b", () => load("b"))
    await cache.getOrLoad("a", () => load("unused"))
    await cache.getOrLoad("c", () => load("c"))
    expect(cache.size()).toBe(2)
    expect(await cache.getOrLoad("b", () => load("b-reloaded"))).toBe("b-reloaded")
    expect(loads).toBe(4)
  })

  test("bounds total retained catalog size and skips oversized values", async () => {
    const cache = createExternalMcpSearchCache<string>({
      maxEntries: 10,
      maxTotalSize: 5,
      sizeOf: (value) => value.length,
      ttlMs: 1_000,
    })

    await cache.getOrLoad("a", async () => "aaa")
    await cache.getOrLoad("b", async () => "bb")
    await cache.getOrLoad("c", async () => "cccc")
    expect(cache.size()).toBe(1)
    expect(cache.totalSize()).toBe(4)

    await cache.getOrLoad("oversized", async () => "123456")
    expect(cache.size()).toBe(1)
    expect(cache.totalSize()).toBe(4)
  })
})
