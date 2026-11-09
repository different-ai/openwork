/**
 * Small helpers shared by the config-blob engine. Pure: no I/O, no db.
 */
import { createHash } from "node:crypto"
import { isConfigRef, isConfigSecret } from "@openwork/types/den/config-blobs"
import type { ConfigArea } from "../area.js"

export type JsonObject = { [key: string]: unknown }

/** How an area lays out its arrays: which are ordered, which key identifies set elements. */
export type ArrayLayout = Pick<ConfigArea, "orderedArrays" | "arrayKeys">

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

export function isOrderedArray(layout: ArrayLayout, schemaPath: string): boolean {
  return (layout.orderedArrays ?? []).includes(schemaPath)
}

/**
 * The identity of a set element: `arrayKeys[path]`, else `id`, else `$ref`.
 * Null for elements with none (scalars, unkeyed objects).
 */
export function arrayElementKey(layout: ArrayLayout, schemaPath: string, element: unknown): { field: string; value: string } | null {
  if (isConfigRef(element)) return { field: "$ref", value: element.$ref }
  if (!isPlainObject(element) || isConfigSecret(element)) return null
  const declared = layout.arrayKeys?.[schemaPath]
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

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
