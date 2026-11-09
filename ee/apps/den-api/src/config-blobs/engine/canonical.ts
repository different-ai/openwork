/**
 * Canonical JSON and hashes for config-blob specs (format.md › Hashes).
 *
 * - object keys are sorted (code-point order, also for integer-like keys);
 * - arrays listed in `orderedArrays` keep their order, every other array is a
 *   set sorted by `arrayKeys[path]`, else `id`, else `$ref`, else the
 *   element's canonical JSON;
 * - a `$secret` placeholder hashes as `{ $secret: "<schema path>" }`: its
 *   set/keep/env/unset decision and its item-specific path never count;
 * - a `$ref` hashes as `{ $ref }`: the `name` hint (and any resolved `id`)
 *   never count;
 * - `informationalFields` are left out.
 */
import { isConfigRef, isConfigSecret, type ConfigAreaKey } from "@openwork/types/den/config-blobs"
import {
  type ArrayLayout,
  arrayElementKey,
  elementSchemaPath,
  isInformationalField,
  isOrderedArray,
  isPlainObject,
  joinPath,
  sha256,
} from "./util.js"

const NO_LAYOUT: ArrayLayout = {}

/** The normalized value hashing is computed over. `schemaPath` is where `value` sits in the spec. */
export function normalizeSpecValue(layout: ArrayLayout, value: unknown, schemaPath = ""): unknown {
  if (isConfigSecret(value)) return { $secret: schemaPath }
  if (isConfigRef(value)) return { $ref: value.$ref }
  if (Array.isArray(value)) {
    const childPath = elementSchemaPath(schemaPath)
    const elements = value.map((element) => normalizeSpecValue(layout, element, childPath))
    if (isOrderedArray(layout, schemaPath)) return elements
    const keyed = elements.map((element) => {
      const key = arrayElementKey(layout, childPath, element)
      return { sortKey: key ? `${key.field}=${key.value}` : stringifyCanonical(element), element }
    })
    keyed.sort((a, b) => compareStrings(a.sortKey, b.sortKey))
    return keyed.map((entry) => entry.element)
  }
  if (isPlainObject(value)) {
    const out: { [key: string]: unknown } = {}
    for (const key of Object.keys(value).sort(compareStrings)) {
      const child = value[key]
      if (child === undefined || isInformationalField(layout, joinPath(schemaPath, key))) continue
      out[key] = normalizeSpecValue(layout, child, joinPath(schemaPath, key))
    }
    return out
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

/** JSON with object keys emitted in sorted order. */
export function stringifyCanonical(value: unknown): string {
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map((element) => stringifyCanonical(element)).join(",")}]`
  if (isPlainObject(value)) {
    const parts: string[] = []
    for (const key of Object.keys(value).sort(compareStrings)) {
      const child = value[key]
      if (child === undefined) continue
      parts.push(`${JSON.stringify(key)}:${stringifyCanonical(child)}`)
    }
    return `{${parts.join(",")}}`
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : "null"
  if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value)
  return "null"
}

/** Canonical JSON of a spec (or a value inside one at `schemaPath`). */
export function canonicalJson(layout: ArrayLayout, value: unknown, schemaPath = ""): string {
  return stringifyCanonical(normalizeSpecValue(layout, value, schemaPath))
}

/** Canonical JSON of a value that has no area layout (decisions, plan parts): every array is a set. */
export function canonicalJsonPlain(value: unknown): string {
  return canonicalJson(NO_LAYOUT, value)
}

/** `rev` of a spec: `sha256:<hex>` of its canonical JSON. */
export function specRev(area: ArrayLayout, spec: unknown): string {
  return sha256(canonicalJson(area, spec))
}

/** `baseHash`: hash over the sorted `(area, id, rev)` of everything in scope. */
export function baseHash(entries: ReadonlyArray<{ area: ConfigAreaKey; id: string; rev: string }>): string {
  const rows = entries
    .map((entry) => [entry.area, entry.id, entry.rev])
    .sort((a, b) => compareStrings(a.join("\u0000"), b.join("\u0000")))
  return sha256(JSON.stringify(rows))
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
