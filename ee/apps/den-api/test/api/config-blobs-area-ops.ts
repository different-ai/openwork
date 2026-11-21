import type { ConfigFieldChange, ConfigSpec } from "@openwork/types/den/config-blobs"
import type { ConfigApplyOp, ConfigArea, ConfigItem } from "../../src/config-blobs/area.js"
import { diffSpecs, findSecrets } from "../../src/config-blobs/engine/index.js"

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function storedSecrets(value: unknown, out = new Map<string, boolean>()): Map<string, boolean> {
  if (Array.isArray(value)) for (const entry of value) storedSecrets(entry, out)
  else if (isObject(value)) {
    if (typeof value.$secret === "string") out.set(value.$secret, value.set === true)
    else for (const entry of Object.values(value)) storedSecrets(entry, out)
  }
  return out
}

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

function valueSecretPaths(area: ConfigArea, spec: ConfigSpec): string[] {
  return findSecrets(area, spec).flatMap((occurrence) => {
    const placeholder: unknown = occurrence.placeholder
    return isObject(placeholder) && placeholder.decision === "value" ? [occurrence.field] : []
  })
}

export function planChanges(area: ConfigArea, previous: ConfigItem, item: { name: string; key?: string | null; spec: ConfigSpec }): ConfigFieldChange[] {
  const after = unresolved(item.spec, storedSecrets(previous.spec))
  const changes = diffSpecs(area, previous.spec, after)
  if (!area.informationalName && item.name !== previous.name) changes.unshift({ path: "name", from: previous.name, to: item.name })
  if (item.key !== undefined && (item.key ?? null) !== (previous.key ?? null)) changes.unshift({ path: "key", from: previous.key ?? null, to: item.key ?? null })
  return changes
}

export function updateOp(area: ConfigArea, previous: ConfigItem, item: { name: string; key?: string | null; spec: ConfigSpec; sourceId?: string }): Extract<ConfigApplyOp, { kind: "update" }> {
  return {
    kind: "update",
    targetId: previous.id,
    previous,
    item,
    changes: planChanges(area, previous, item),
    secretPaths: valueSecretPaths(area, item.spec),
  }
}
