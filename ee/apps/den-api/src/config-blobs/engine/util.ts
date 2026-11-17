/**
 * Small helpers shared by the config-blob engine. Pure: no I/O, no db.
 */
import { createHash } from "node:crypto"
import { isConfigRef, isConfigSecret, isForbiddenConfigKey } from "@openwork/types/den/config-blobs"
import type { ConfigArea } from "../area.js"

export type JsonObject = { [key: string]: unknown }

/** How an area lays out its arrays: which are ordered, which key identifies set elements. */
export type ArrayLayout = Pick<ConfigArea, "orderedArrays" | "arrayKeys" | "informationalFields" | "derivedFields" | "comparableSpec">

/**
 * The spec as compared, hashed and diffed: `layout.comparableSpec` applied
 * once, at the top. Returns the layout to keep walking with (without the
 * hook, so nested calls never apply it again).
 */
export function comparableTop(layout: ArrayLayout, value: unknown): { layout: ArrayLayout; value: unknown } {
  if (!layout.comparableSpec || !isPlainObject(value)) return { layout, value }
  const { comparableSpec, ...rest } = layout
  return { layout: rest, value: comparableSpec(value) }
}

/** Whether the spec field at `schemaPath` is informational (never diffed or hashed). */
export function isInformationalField(layout: ArrayLayout, schemaPath: string): boolean {
  return (layout.informationalFields ?? []).includes(schemaPath)
}

/** Whether the spec field at `schemaPath` is derived on the target (hashed, never diffed). */
export function isDerivedField(layout: ArrayLayout, schemaPath: string): boolean {
  return (layout.derivedFields ?? []).includes(schemaPath)
}

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

/** Joins an object key onto a path: "" + "a" = "a", "a" + "b" = "a.b". */
export function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

/** The schema path of an array's elements: "models" → "models[]". */
export function elementSchemaPath(schemaPath: string): string {
  return `${schemaPath}[]`
}

/** "models[]" → "models"; other paths unchanged. */
export function arraySchemaPath(elementPath: string): string {
  return elementPath.endsWith("[]") ? elementPath.slice(0, -2) : elementPath
}

/**
 * Whether the array at `schemaPath` keeps its order. `orderedArrays` lists
 * array paths ("pinnedModelIds"); the element form ("pinnedModelIds[]") is
 * accepted too.
 */
export function isOrderedArray(layout: ArrayLayout, schemaPath: string): boolean {
  const ordered = layout.orderedArrays ?? []
  return ordered.includes(schemaPath) || ordered.includes(elementSchemaPath(schemaPath))
}

/**
 * The identity of a set element: `arrayKeys[path]`, else `id`, else `$ref`.
 * Null for elements with none (scalars, unkeyed objects). `schemaPath` is the
 * element path ("models[]"); `arrayKeys` is keyed by the array path
 * ("models", as documented in area.ts), the element form is accepted too.
 */
export function arrayElementKey(layout: ArrayLayout, schemaPath: string, element: unknown): { field: string; value: string } | null {
  if (isConfigRef(element)) return { field: "$ref", value: element.$ref }
  if (!isPlainObject(element) || isConfigSecret(element)) return null
  const declared = layout.arrayKeys?.[arraySchemaPath(schemaPath)] ?? layout.arrayKeys?.[schemaPath]
  if (declared) {
    const value = element[declared]
    if (typeof value === "string" || typeof value === "number") return { field: declared, value: String(value) }
  }
  const id = element.id
  if (typeof id === "string" || typeof id === "number") return { field: "id", value: String(id) }
  return null
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Whether a key must never be copied onto a new object: `__proto__`,
 * `constructor`, `prototype`. Validation rejects blobs holding them; copies
 * skip them too, so nothing built from a spec can reach a prototype.
 */
export function isUnsafeKey(key: string): boolean {
  return isForbiddenConfigKey(key)
}

/** The TypeID prefix of an id (`ipr_01h…` → `ipr`), or null when it has none. */
export function typeIdPrefix(id: string): string | null {
  const underscore = id.lastIndexOf("_")
  return underscore > 0 ? id.slice(0, underscore) : null
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
