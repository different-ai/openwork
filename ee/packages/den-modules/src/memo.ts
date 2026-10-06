import { mapModuleIds } from "@openwork/license-contracts"
import type { ModuleId } from "@openwork/license-contracts/modules"
import type { EffectiveModules, ModuleState } from "@openwork/license-contracts/resolver"

const ON: ModuleState = Object.freeze({ state: "on" })
const simpleOff = new Map<string, ModuleState>()
const requiresOff = new Map<ModuleId, ModuleState>()
const unavailableOff = new Map<string, ModuleState>()
const MAX_INTERNED_DETAILS = 256

function interned<K>(cache: Map<K, ModuleState>, key: K, build: () => ModuleState): ModuleState {
  const hit = cache.get(key)
  if (hit) return hit
  const value = Object.freeze(build())
  if (cache.size < MAX_INTERNED_DETAILS) cache.set(key, value)
  return value
}

/** Shares frozen singletons for `on` and detail-less `off` states, so a memo entry is one small record. */
export function internModuleState(state: ModuleState): ModuleState {
  if (state.state === "on") return ON
  if (state.state === "restricted") {
    return Object.freeze({ state: "restricted", until: state.until, operations: Object.freeze({ ...state.operations }) })
  }
  switch (state.reason) {
    case "requires": {
      const requires = state.requires
      return interned(requiresOff, requires, () => ({ state: "off", reason: "requires", requires }))
    }
    case "not_available": {
      const detail = state.detail
      return interned(unavailableOff, detail, () => ({ state: "off", reason: "not_available", detail }))
    }
    default: {
      const reason = state.reason
      return interned(simpleOff, reason, () => ({ state: "off", reason }))
    }
  }
}

export function internEffectiveModules(value: EffectiveModules): EffectiveModules {
  const modules = Object.freeze(mapModuleIds((id) => internModuleState(value.modules[id])))
  return Object.freeze({ ...value, modules, featureFlags: Object.freeze({ ...value.featureFlags }) })
}

interface MemoEntry {
  readonly key: string
  readonly value: EffectiveModules
  readonly expiresAt: number
}

/**
 * One entry per org, keyed by `revision | instanceVersion | inputsDigest`,
 * LRU by re-insertion. An entry expires at the resolver's `validUntil` (the
 * next license time boundary) or after `maxTtlMs`, whichever comes first.
 */
export class EffectiveModulesMemo {
  private readonly entries = new Map<string, MemoEntry>()

  constructor(
    readonly maxEntries: number,
    readonly maxTtlMs: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("memo.maxEntries must be a positive integer")
    if (!Number.isFinite(maxTtlMs) || maxTtlMs <= 0) throw new Error("memo.maxTtlMs must be positive")
  }

  get size(): number {
    return this.entries.size
  }

  /** The stored entry, even if stale or for another key. Does not touch LRU order. */
  peek(organizationId: string): MemoEntry | undefined {
    return this.entries.get(organizationId)
  }

  /** A fresh hit for this key, or `undefined`. */
  get(organizationId: string, key: string, nowMs: number): EffectiveModules | undefined {
    const entry = this.entries.get(organizationId)
    if (!entry || entry.key !== key || entry.expiresAt <= nowMs) return undefined
    this.entries.delete(organizationId)
    this.entries.set(organizationId, entry)
    return entry.value
  }

  set(organizationId: string, key: string, value: EffectiveModules, nowMs: number): void {
    const boundary = value.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(value.validUntil)
    const expiresAt = Math.min(Number.isNaN(boundary) ? Number.POSITIVE_INFINITY : boundary, nowMs + this.maxTtlMs)
    this.entries.delete(organizationId)
    this.entries.set(organizationId, { key, value, expiresAt })
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  delete(organizationId: string): void {
    this.entries.delete(organizationId)
  }

  clear(): void {
    this.entries.clear()
  }
}
