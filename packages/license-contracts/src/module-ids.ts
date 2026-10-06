import { z } from "zod"
import { MODULE_GROUPS, MODULE_IDS, type ModuleGroupId, type ModuleId } from "./module-id-list"

export { MODULE_GROUPS, MODULE_ID_MAX_SEGMENTS, MODULE_IDS, type ModuleGroupId, type ModuleId } from "./module-id-list"

/** Strict id schema, for authoring (license server writes). Den parsing uses tolerant string keys. */
export const moduleIdSchema = z.enum(MODULE_IDS)

const MODULE_ID_SET: ReadonlySet<string> = new Set(MODULE_IDS)
const MODULE_ID_ORDER: ReadonlyMap<string, number> = new Map(MODULE_IDS.map((id, index) => [id, index]))

const MODULE_GROUP_SET: ReadonlySet<string> = new Set(MODULE_GROUPS)

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && MODULE_ID_SET.has(value)
}

/** A group (D44): a pure namespace, never a module. */
export function isModuleGroupId(value: unknown): value is ModuleGroupId {
  return typeof value === "string" && MODULE_GROUP_SET.has(value)
}

/** Every proper prefix of a dotted id, nearest first (`a.b.c` → `a.b`, `a`). */
export function moduleIdPrefixes(id: string): string[] {
  const parts = id.split(".")
  const prefixes: string[] = []
  for (let length = parts.length - 1; length > 0; length -= 1) prefixes.push(parts.slice(0, length).join("."))
  return prefixes
}

/**
 * The module's parent by location (D44): the nearest prefix that is a module.
 * Groups are skipped, so a module directly under a group has no parent.
 */
export function nearestModuleAncestor(id: ModuleId): ModuleId | null {
  for (const prefix of moduleIdPrefixes(id)) {
    if (isModuleId(prefix)) return prefix
  }
  return null
}

function isCompleteModuleRecord<T>(record: Partial<Record<ModuleId, T>>): record is Record<ModuleId, T> {
  return MODULE_IDS.every((id) => Object.prototype.hasOwnProperty.call(record, id))
}

/** Builds a record with one entry per module id, in MODULE_IDS order. */
export function mapModuleIds<T>(build: (id: ModuleId) => T): Record<ModuleId, T> {
  const record: Partial<Record<ModuleId, T>> = {}
  for (const id of MODULE_IDS) record[id] = build(id)
  if (!isCompleteModuleRecord(record)) throw new Error("Module record is incomplete")
  return record
}

/** Keeps known ids, drops unknown or retired strings, dedupes, and preserves MODULE_IDS order. */
export function parseModuleIdList(values: readonly unknown[]): ModuleId[] {
  const seen = new Set<ModuleId>()
  for (const value of values) {
    if (isModuleId(value)) seen.add(value)
  }
  return [...seen].sort((a, b) => (MODULE_ID_ORDER.get(a) ?? 0) - (MODULE_ID_ORDER.get(b) ?? 0))
}
