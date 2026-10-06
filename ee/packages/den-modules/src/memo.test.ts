import { mapModuleIds } from "@openwork/license-contracts"
import { resolveModules, type EffectiveModules } from "@openwork/license-contracts/resolver"
import { describe, expect, test } from "vitest"
import { EffectiveModulesMemo, internEffectiveModules } from "./memo"

const now = new Date("2026-10-06T12:00:00.000Z")
const allEntitled = mapModuleIds(() => true)
const allAvailable = mapModuleIds((): true => true)

function effective(validUntil: string | null = null): EffectiveModules {
  const value = resolveModules({ deployment: "cloud", availability: allAvailable, entitlement: { source: "static", modules: allEntitled }, disabled: [], now })
  return { ...value, validUntil }
}

describe("EffectiveModulesMemo", () => {
  test("hits on the same key and misses on a new revision, digest or instance version", () => {
    const memo = new EffectiveModulesMemo(10, 600_000)
    const value = effective()
    memo.set("org_a", "1|1.0|t:free", value, now.getTime())
    expect(memo.get("org_a", "1|1.0|t:free", now.getTime())).toBe(value)
    expect(memo.get("org_a", "2|1.0|t:free", now.getTime())).toBeUndefined()
    expect(memo.get("org_a", "1|1.0|t:team", now.getTime())).toBeUndefined()
    expect(memo.get("org_a", "1|1.1|t:free", now.getTime())).toBeUndefined()
    expect(memo.peek("org_a")?.value).toBe(value)
  })

  test("expires exactly at validUntil", () => {
    const memo = new EffectiveModulesMemo(10, 600_000)
    const boundary = now.getTime() + 5_000
    memo.set("org_a", "k", effective(new Date(boundary).toISOString()), now.getTime())
    expect(memo.get("org_a", "k", boundary - 1)).toBeDefined()
    expect(memo.get("org_a", "k", boundary)).toBeUndefined()
  })

  test("caps the TTL at maxTtlMs", () => {
    const memo = new EffectiveModulesMemo(10, 1_000)
    memo.set("org_a", "k", effective(), now.getTime())
    expect(memo.get("org_a", "k", now.getTime() + 999)).toBeDefined()
    expect(memo.get("org_a", "k", now.getTime() + 1_000)).toBeUndefined()
  })

  test("evicts the least recently used entry at maxEntries", () => {
    const memo = new EffectiveModulesMemo(2, 600_000)
    memo.set("org_a", "k", effective(), now.getTime())
    memo.set("org_b", "k", effective(), now.getTime())
    expect(memo.get("org_a", "k", now.getTime())).toBeDefined()
    memo.set("org_c", "k", effective(), now.getTime())
    expect(memo.size).toBe(2)
    expect(memo.peek("org_b")).toBeUndefined()
    expect(memo.peek("org_a")).toBeDefined()
  })

  test("rejects invalid bounds", () => {
    expect(() => new EffectiveModulesMemo(0, 1)).toThrow()
    expect(() => new EffectiveModulesMemo(1, 0)).toThrow()
  })
})

describe("internEffectiveModules", () => {
  test("shares frozen state objects across results", () => {
    const first = internEffectiveModules(effective())
    const second = internEffectiveModules(effective())
    expect(first.modules.customProviders).toBe(second.modules.customProviders)
        expect(first.modules.billing).toBe(second.modules.billing)
    expect(Object.isFrozen(first.modules)).toBe(true)
    expect(Object.isFrozen(first.modules.customProviders)).toBe(true)
    expect(first.modules.customProviders).toEqual({ state: "on" })
  })

  test("keeps requires and detail-carrying states distinct", () => {
    const value = internEffectiveModules(resolveModules({
      deployment: "cloud",
      availability: { ...allAvailable, automations: { reason: "off" } },
      entitlement: { source: "static", modules: allEntitled },
      disabled: ["connect"],
      now,
    }))
    expect(value.modules.automations).toEqual({ state: "off", reason: "not_available", detail: "off" })
    expect(value.modules.mcpApps).toEqual({ state: "off", reason: "requires", requires: "connect" })
  })
})
