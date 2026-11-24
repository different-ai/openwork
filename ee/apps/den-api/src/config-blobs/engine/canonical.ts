import { isConfigRef, isConfigSecret, type ConfigAreaKey } from "@openwork/types/den/config-blobs"
import {
  type ArrayLayout,
  arrayElementKey,
  comparableTop,
  elementSchemaPath,
  isInformationalField,
  isOrderedArray,
  isPlainObject,
  isUnsafeKey,
  joinPath,
  sha256,
} from "./util.js"
import type { ConfigArea } from "../area.js"

const NO_LAYOUT: ArrayLayout = {}

export function normalizeSpecValue(layout: ArrayLayout, value: unknown, schemaPath = ""): unknown {
  if (schemaPath === "" && layout.comparableSpec) {
    const top = comparableTop(layout, value)
    return normalizeSpecValue(top.layout, top.value, schemaPath)
  }
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
      if (child === undefined || isUnsafeKey(key) || isInformationalField(layout, joinPath(schemaPath, key))) continue
      out[key] = normalizeSpecValue(layout, child, joinPath(schemaPath, key))
    }
    return out
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

export function stringifyCanonical(value: unknown): string {
  if (value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map((element) => stringifyCanonical(element)).join(",")}]`
  if (isPlainObject(value)) {
    const parts: string[] = []
    for (const key of Object.keys(value).sort(compareStrings)) {
      const child = value[key]
      if (child === undefined || isUnsafeKey(key)) continue
      parts.push(`${JSON.stringify(key)}:${stringifyCanonical(child)}`)
    }
    return `{${parts.join(",")}}`
  }
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : "null"
  if (typeof value === "string" || typeof value === "boolean" || value === null) return JSON.stringify(value)
  return "null"
}

export function canonicalJson(layout: ArrayLayout, value: unknown, schemaPath = ""): string {
  return stringifyCanonical(normalizeSpecValue(layout, value, schemaPath))
}

export function canonicalJsonPlain(value: unknown): string {
  return canonicalJson(NO_LAYOUT, value)
}

export function specRev(area: ArrayLayout, spec: unknown): string {
  return sha256(canonicalJson(area, spec))
}

export type RevLayout = ArrayLayout & Pick<ConfigArea, "informationalName" | "assignedKeys">

export function itemRev(area: RevLayout, item: { name: string; key?: string | null; spec: unknown }): string {
  return sha256(stringifyCanonical({
    spec: normalizeSpecValue(area, item.spec),
    name: area.informationalName ? null : item.name,
    key: area.assignedKeys ? null : item.key ?? null,
  }))
}

export function baseHash(entries: ReadonlyArray<{ area: ConfigAreaKey; id: string; rev: string }>): string {
  const rows = entries
    .map((entry) => [entry.area, entry.id, entry.rev])
    .sort((a, b) => compareStrings(a.join("\u0000"), b.join("\u0000")))
  return sha256(JSON.stringify(rows))
}

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
