/**
 * Field-level diff of two specs and the classification of a matched pair
 * (mapping.md › Change states, › Three-way diff).
 *
 * Paths: object keys join with ".", keyed set elements appear as
 * `models[id=abc]` / `entries[modelId=x]`, so a change reads
 * `models[id=abc].enabled`. Sets of `$ref`s and of scalars produce one change
 * on the array path with `added` / `removed`. Ordered arrays (and unkeyed
 * object arrays) that differ produce one whole-array change.
 */
import type { ConfigBlobItem, ConfigFieldChange, ConfigPlanFlag, ConfigSpec } from "@openwork/types/den/config-blobs"
import { isConfigRef, isConfigSecret } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigItem } from "../area.js"
import { canonicalJson, compareStrings, specRev } from "./canonical.js"
import {
  type ArrayLayout,
  arrayElementKey,
  elementSchemaPath,
  isOrderedArray,
  isPlainObject,
  joinPath,
} from "./util.js"

/**
 * A field change. `added` / `removed` list set members (ref name hints, or
 * values) for set-valued fields such as `access.teams`. They extend the
 * shared `ConfigFieldChange` and are present in the plan JSON.
 */
export type EngineFieldChange = ConfigFieldChange & { added?: unknown[]; removed?: unknown[] }

export function diffSpecs(layout: ArrayLayout, before: unknown, after: unknown): EngineFieldChange[] {
  const changes: EngineFieldChange[] = []
  walk(layout, before, after, "", "", changes)
  return changes
}

function walk(layout: ArrayLayout, before: unknown, after: unknown, path: string, schemaPath: string, out: EngineFieldChange[]): void {
  if (canonicalJson(layout, before, schemaPath) === canonicalJson(layout, after, schemaPath)) return
  const displayPath = path || "(spec)"
  if (isStructObject(before) && isStructObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareStrings)
    for (const key of keys) walk(layout, before[key], after[key], joinPath(path, key), joinPath(schemaPath, key), out)
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (isOrderedArray(layout, schemaPath)) {
      out.push({ path: displayPath, from: before, to: after })
      return
    }
    const childSchema = elementSchemaPath(schemaPath)
    const beforeKeyed = new Map<string, { label: string; element: unknown }>()
    const afterKeyed = new Map<string, { label: string; element: unknown }>()
    const beforeLoose = new Map<string, unknown>()
    const afterLoose = new Map<string, unknown>()
    const sort = (elements: unknown[], keyed: typeof beforeKeyed, loose: typeof beforeLoose) => {
      for (const element of elements) {
        const key = arrayElementKey(layout, childSchema, element)
        if (key && key.field !== "$ref") keyed.set(key.value, { label: `${key.field}=${key.value}`, element })
        else loose.set(key ? `$ref=${key.value}` : canonicalJson(layout, element, childSchema), element)
      }
    }
    sort(before, beforeKeyed, beforeLoose)
    sort(after, afterKeyed, afterLoose)
    for (const key of [...new Set([...beforeKeyed.keys(), ...afterKeyed.keys()])].sort(compareStrings)) {
      const left = beforeKeyed.get(key)
      const right = afterKeyed.get(key)
      const label = (left ?? right)!.label
      const elementPath = `${path}[${label}]`
      if (left && right) walk(layout, left.element, right.element, elementPath, childSchema, out)
      else if (right) out.push({ path: elementPath, to: right.element })
      else if (left) out.push({ path: elementPath, from: left.element })
    }
    const added = [...afterLoose.entries()].filter(([key]) => !beforeLoose.has(key)).map(([, element]) => displayMember(element))
    const removed = [...beforeLoose.entries()].filter(([key]) => !afterLoose.has(key)).map(([, element]) => displayMember(element))
    if (added.length || removed.length) out.push({ path: displayPath, added, removed })
    return
  }
  out.push({ path: displayPath, from: before, to: after })
}

/** A plain object that is not a `$ref` or `$secret` placeholder. */
function isStructObject(value: unknown): value is { [key: string]: unknown } {
  return isPlainObject(value) && !isConfigRef(value) && !isConfigSecret(value)
}

function displayMember(element: unknown): unknown {
  if (isConfigRef(element)) return element.name ?? element.$ref
  return element
}

/** Removes something that exists on the target: deleted fields, removed set members or elements. */
export function isDestructiveChange(change: EngineFieldChange): boolean {
  if (change.removed && change.removed.length > 0) return true
  return change.from !== undefined && change.to === undefined && change.added === undefined
}

// ---------------------------------------------------------------------------
// Classification of a matched pair

export type MatchedClassification = {
  op: "update" | "rename" | "unchanged" | "untouched"
  fields: EngineFieldChange[]
  flags: ConfigPlanFlag[]
  reasons: string[]
  /** Hash of the target's current spec. */
  targetRev: string
  /** Hash of the blob's spec as uploaded (refs as written). */
  oursRev: string
}

export type ClassifyMatchedInput = {
  area: Pick<ConfigArea, "orderedArrays" | "arrayKeys" | "cosmeticFields">
  blob: Pick<ConfigBlobItem, "name" | "key" | "rev" | "spec">
  /** The blob spec with refs rewritten to the target's ids (what would be written). */
  localizedSpec: ConfigSpec
  target: ConfigItem
  /** Use `blob.rev` as the three-way base (only when the blob came from this same org). */
  threeWay: boolean
  /** The admin chose "overwrite with blob" for a drifted item. */
  override: boolean
  /** The spec at export, when known: enables per-field base values and conflicts. */
  baseSpec?: ConfigSpec
}

export function classifyMatched(input: ClassifyMatchedInput): MatchedClassification {
  const { area, blob, target } = input
  const targetRev = specRev(area, target.spec)
  const oursRev = specRev(area, blob.spec)
  const fields = diffSpecs(area, target.spec, input.localizedSpec)
  const nameChanged = blob.name !== target.name
  const keyChanged = blob.key !== undefined && (blob.key ?? null) !== (target.key ?? null)
  const flags: ConfigPlanFlag[] = []
  const reasons: string[] = []
  if (nameChanged) fields.unshift({ path: "name", from: target.name, to: blob.name })
  if (keyChanged) fields.unshift({ path: "key", from: target.key ?? null, to: blob.key ?? null })

  const base = input.threeWay ? blob.rev : undefined
  if (base && base !== targetRev) {
    if (oursRev === base && !input.override) {
      return {
        op: "untouched",
        fields,
        flags,
        reasons: ["changed on the target since export and not edited in the blob: left as it is (choose overwrite to apply the blob)"],
        targetRev,
        oursRev,
      }
    }
    if (input.override) reasons.push("changed on the target since export: overwrite with blob (confirmed)")
    else {
      flags.push("drift")
      reasons.push("changed both on the target and in the blob since export")
    }
    if (input.baseSpec) markConflicts(area, fields, input.baseSpec, blob.spec, target.spec)
  }

  const specFields = fields.filter((field) => field.path !== "name" && field.path !== "key")
  if (fields.length === 0) return { op: "unchanged", fields, flags, reasons, targetRev, oursRev }
  if (specFields.length > 0 && fields.some(isDestructiveChange)) flags.push("destructive")
  const cosmetic = area.cosmeticFields ?? []
  const onlyCosmetic = specFields.every((field) => cosmetic.some((prefix) => field.path === prefix || field.path.startsWith(`${prefix}.`) || field.path.startsWith(`${prefix}[`)))
  if ((nameChanged || keyChanged) && onlyCosmetic) return { op: "rename", fields, flags, reasons, targetRev, oursRev }
  return { op: "update", fields, flags, reasons, targetRev, oursRev }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || a.startsWith(`${b}[`) || b.startsWith(`${a}.`) || b.startsWith(`${a}[`)
}

function markConflicts(layout: ArrayLayout, fields: EngineFieldChange[], baseSpec: ConfigSpec, ours: ConfigSpec, theirs: ConfigSpec): void {
  const oursChanges = diffSpecs(layout, baseSpec, ours)
  const theirsChanges = diffSpecs(layout, baseSpec, theirs)
  for (const field of fields) {
    if (field.path === "name" || field.path === "key") continue
    const ourChange = oursChanges.find((change) => overlaps(change.path, field.path))
    const theirChange = theirsChanges.find((change) => overlaps(change.path, field.path))
    const exact = oursChanges.find((change) => change.path === field.path) ?? theirsChanges.find((change) => change.path === field.path)
    if (exact && exact.added === undefined) field.base = exact.from
    field.conflict = Boolean(ourChange && theirChange)
  }
}
