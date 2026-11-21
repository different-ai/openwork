import { createHash } from "node:crypto"
import { isConfigRef, isConfigSecret, isForbiddenConfigKey } from "@openwork/types/den/config-blobs"
import type { ConfigArea } from "../area.js"

export type JsonObject = { [key: string]: unknown }

export type ArrayLayout = Pick<ConfigArea, "orderedArrays" | "arrayKeys" | "informationalFields" | "derivedFields" | "comparableSpec">

export function comparableTop(layout: ArrayLayout, value: unknown): { layout: ArrayLayout; value: unknown } {
  if (!layout.comparableSpec || !isPlainObject(value)) return { layout, value }
  const { comparableSpec, ...rest } = layout
  return { layout: rest, value: comparableSpec(value) }
}

export function isInformationalField(layout: ArrayLayout, schemaPath: string): boolean {
  return (layout.informationalFields ?? []).includes(schemaPath)
}

export function isDerivedField(layout: ArrayLayout, schemaPath: string): boolean {
  return (layout.derivedFields ?? []).includes(schemaPath)
}

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

export function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key
}

export function elementSchemaPath(schemaPath: string): string {
  return `${schemaPath}[]`
}

export function arraySchemaPath(elementPath: string): string {
  return elementPath.endsWith("[]") ? elementPath.slice(0, -2) : elementPath
}

export function isOrderedArray(layout: ArrayLayout, schemaPath: string): boolean {
  const ordered = layout.orderedArrays ?? []
  return ordered.includes(schemaPath) || ordered.includes(elementSchemaPath(schemaPath))
}

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

export function isUnsafeKey(key: string): boolean {
  return isForbiddenConfigKey(key)
}

export function typeIdPrefix(id: string): string | null {
  const underscore = id.lastIndexOf("_")
  return underscore > 0 ? id.slice(0, underscore) : null
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
