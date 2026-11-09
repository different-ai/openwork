/**
 * Builds config-blob apply ops the way the engine does, for the area adapter
 * tests: an update carries the plan's field changes (from the engine's own
 * diff) and the paths of secrets that carry a new value.
 */
import type { ConfigFieldChange, ConfigSpec } from "@openwork/types/den/config-blobs"
import type { ConfigApplyOp, ConfigArea, ConfigItem } from "../../src/config-blobs/area.js"
import { diffSpecs } from "../../src/config-blobs/engine/index.js"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** `$secret` path → whether a value is stored, from an exported spec. */
function storedSecrets(value: unknown, out = new Map<string, boolean>()): Map<string, boolean> {
  if (Array.isArray(value)) for (const entry of value) storedSecrets(entry, out)
  else if (isObject(value)) {
    if (typeof value.$secret === "string") out.set(value.$secret, value.set === true)
    else for (const entry of Object.values(value)) storedSecrets(entry, out)
  }
  return out
}

/**
 * A resolved spec back in blob form: refs without their local `id`, secret
 * decisions as placeholders (keep: as stored; value: set; unset: not set).
 */
export function unresolved(value: unknown, stored: Map<string, boolean>): unknown {
  if (Array.isArray(value)) return value.map((entry) => unresolved(entry, stored))
  if (!isObject(value)) return value
  if (typeof value.$secret === "string") {
    const set = value.decision === "value" ? true : value.decision === "unset" ? false : stored.get(value.$secret) ?? false
    return { $secret: value.$secret, set }
  }
  if (typeof value.$ref === "string") {
    const { id: _id, ...ref } = value
    return ref
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unresolved(entry, stored)]))
}

/** Spec paths of secrets that carry a new value, e.g. `credentials.apiKey`, `requestHeaders[name=X].value`. */
function valueSecretPaths(value: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const key = isObject(entry) && typeof entry.id === "string" ? `id=${entry.id}` : isObject(entry) && typeof entry.name === "string" ? `name=${entry.name}` : String(index)
      valueSecretPaths(entry, `${path}[${key}]`, out)
    })
  } else if (isObject(value)) {
    if (typeof value.$secret === "string") {
      if (value.decision === "value") out.push(path)
    } else for (const [key, entry] of Object.entries(value)) valueSecretPaths(entry, path ? `${path}.${key}` : key, out)
  }
  return out
}

/** The plan's changes between the target as exported and the (resolved) item to write. */
export function planChanges(area: ConfigArea, previous: ConfigItem, item: { name: string; key?: string | null; spec: ConfigSpec }): ConfigFieldChange[] {
  const after = unresolved(item.spec, storedSecrets(previous.spec))
  const changes = diffSpecs(area, previous.spec, after)
  if (!area.informationalName && item.name !== previous.name) changes.unshift({ path: "name", from: previous.name, to: item.name })
  if (item.key !== undefined && (item.key ?? null) !== (previous.key ?? null)) changes.unshift({ path: "key", from: previous.key ?? null, to: item.key ?? null })
  return changes
}

/** An update op as the engine sends it. */
export function updateOp(area: ConfigArea, previous: ConfigItem, item: { name: string; key?: string | null; spec: ConfigSpec; sourceId?: string }): Extract<ConfigApplyOp, { kind: "update" }> {
  return {
    kind: "update",
    targetId: previous.id,
    previous,
    item,
    changes: planChanges(area, previous, item),
    secretPaths: valueSecretPaths(item.spec),
  }
}
