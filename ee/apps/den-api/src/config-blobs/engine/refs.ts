/**
 * `$ref` discovery and resolution (format.md › References, mapping.md › References).
 *
 * Paths here are positional, as written in the blob: `access.teams[0]`. They
 * are what `ConfigDecisions.refs[].path` and `ConfigPlanRef.path` use.
 */
import type {
  ConfigAreaKey,
  ConfigDecisions,
  ConfigPlanRef,
  ConfigRef,
} from "@openwork/types/den/config-blobs"
import { isConfigRef, isConfigSecret, parseConfigRef } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigItem } from "../area.js"
import type { ItemMatch } from "./match.js"
import { isPlainObject, joinPath, normalizeEmail } from "./util.js"

export type RefOccurrence = { path: string; ref: string; name?: string }

export function findRefs(spec: unknown, path = "", out: RefOccurrence[] = []): RefOccurrence[] {
  if (isConfigRef(spec)) {
    out.push(spec.name === undefined ? { path, ref: spec.$ref } : { path, ref: spec.$ref, name: spec.name })
    return out
  }
  if (isConfigSecret(spec)) return out
  if (Array.isArray(spec)) {
    spec.forEach((element, index) => findRefs(element, `${path}[${index}]`, out))
    return out
  }
  if (isPlainObject(spec)) for (const [key, value] of Object.entries(spec)) findRefs(value, joinPath(path, key), out)
  return out
}

export const DROP_REF: unique symbol = Symbol("drop-ref")

/**
 * Copies `spec`, replacing every `$ref` with what `replace` returns for it
 * (`DROP_REF` removes it; inside an array the element is removed).
 */
export function rewriteRefs(spec: unknown, replace: (path: string, ref: ConfigRef) => unknown, path = ""): unknown {
  if (isConfigRef(spec)) return replace(path, spec)
  if (isConfigSecret(spec)) return spec
  if (Array.isArray(spec)) {
    const out: unknown[] = []
    spec.forEach((element, index) => {
      const next = rewriteRefs(element, replace, `${path}[${index}]`)
      if (next !== DROP_REF) out.push(next)
    })
    return out
  }
  if (isPlainObject(spec)) {
    const out: { [key: string]: unknown } = {}
    for (const [key, value] of Object.entries(spec)) {
      const next = rewriteRefs(value, replace, joinPath(path, key))
      if (next !== DROP_REF) out[key] = next
    }
    return out
  }
  return spec
}

/** How one reference resolves. `planned` points at a blob item (by its plan ref) that this plan creates. */
export type RefResolution =
  | { kind: "target"; id: string; via: "target" | "decision" }
  | { kind: "planned"; area: ConfigAreaKey; ref: string }
  | { kind: "drop" }
  | { kind: "invite"; email: string }
  | { kind: "unresolved"; reason: string }

export type ResolvedRefOccurrence = RefOccurrence & { resolution: RefResolution }

export type RefResolverInput = {
  /** Areas this plan writes (supported, in scope). */
  scope: ReadonlySet<ConfigAreaKey>
  /** Match results of every area in `scope`. */
  blobMatches: ReadonlyMap<ConfigAreaKey, readonly ItemMatch[]>
  /** Blob items that will not be written (skipped by the admin or unsupported): `${area}\u0000${ref}`. */
  skipped?: ReadonlySet<string>
  /** Current target items, for every area references may point to (in scope or not). */
  targetItems: ReadonlyMap<ConfigAreaKey, readonly ConfigItem[]>
  /** Area definitions, for natural keys of out-of-scope lookups. */
  areas: ReadonlyMap<ConfigAreaKey, Pick<ConfigArea, "naturalKeys">>
  aliases?: ReadonlyMap<ConfigAreaKey, ReadonlyMap<string, string>>
  /** Target org members by normalized email → member id. */
  people?: ReadonlyMap<string, string>
  decisions?: ConfigDecisions["refs"]
}

export const PEOPLE_AREA: ConfigAreaKey = "members.people"

export function skippedKey(area: ConfigAreaKey, ref: string): string {
  return `${area}\u0000${ref}`
}

/** Returns a resolver for references found in items of `itemArea` / `itemRef`. */
export function createRefResolver(input: RefResolverInput): (itemArea: ConfigAreaKey, itemRef: string, occurrence: RefOccurrence) => ResolvedRefOccurrence {
  const decisions = new Map<string, ConfigDecisions["refs"][number]["resolution"]>()
  for (const decision of input.decisions ?? []) decisions.set(`${decision.area}\u0000${decision.ref}\u0000${decision.path}`, decision.resolution)
  const memberIds = new Set(input.people?.values() ?? [])

  const fromBlobMatch = (area: ConfigAreaKey, match: ItemMatch): RefResolution => {
    if (match.target) return { kind: "target", id: match.target.id, via: "target" }
    if (input.skipped?.has(skippedKey(area, match.ref))) return { kind: "unresolved", reason: `${area} item "${match.blob.name}" is skipped in this import` }
    return { kind: "planned", area, ref: match.ref }
  }

  const lookupTarget = (area: ConfigAreaKey, handle: string, hint: string | undefined): RefResolution => {
    const items = input.targetItems.get(area) ?? []
    const byId = items.find((item) => item.id === handle)
    if (byId) return { kind: "target", id: byId.id, via: "target" }
    const aliased = input.aliases?.get(area)?.get(handle)
    const byAlias = aliased ? items.find((item) => item.id === aliased) : undefined
    if (byAlias) return { kind: "target", id: byAlias.id, via: "target" }
    const byKey = items.find((item) => item.key && item.key === handle)
    if (byKey) return { kind: "target", id: byKey.id, via: "target" }
    const naturalKeys = input.areas.get(area)?.naturalKeys ?? []
    if (hint !== undefined) {
      const probe: ConfigItem = { id: handle, key: null, name: hint, spec: {} }
      for (const naturalKey of naturalKeys) {
        const value = naturalKey.get(probe)
        if (value === null) continue
        const hits = items.filter((item) => naturalKey.get(item) === value)
        if (hits.length === 1) return { kind: "target", id: hits[0]!.id, via: "target" }
        if (hits.length > 1) return { kind: "unresolved", reason: `${hits.length} ${area} items share ${naturalKey.label} "${hint}": choose one` }
      }
    }
    return { kind: "unresolved", reason: `no ${area} item "${hint ?? handle}" on this organization` }
  }

  const resolveAuto = (area: ConfigAreaKey | "people", handle: string, hint: string | undefined): RefResolution => {
    if (area === "people") {
      const email = normalizeEmail(handle)
      const memberId = input.people?.get(email)
      if (memberId) return { kind: "target", id: memberId, via: "target" }
      if (input.scope.has(PEOPLE_AREA)) {
        const match = (input.blobMatches.get(PEOPLE_AREA) ?? []).find((candidate) => {
          const value = candidate.blob.spec.email
          return typeof value === "string" && normalizeEmail(value) === email
        })
        if (match) return fromBlobMatch(PEOPLE_AREA, match)
      }
      return { kind: "unresolved", reason: `${handle} is not a member of this organization: invite them or drop them` }
    }
    if (input.scope.has(area)) {
      const match = (input.blobMatches.get(area) ?? []).find((candidate) =>
        candidate.blob.id === handle || (candidate.blob.key && candidate.blob.key === handle) || candidate.ref === handle,
      )
      if (match) return fromBlobMatch(area, match)
    }
    return lookupTarget(area, handle, hint)
  }

  return (itemArea, itemRef, occurrence) => {
    const parsed = parseConfigRef(occurrence.ref)
    const decision = decisions.get(`${itemArea}\u0000${itemRef}\u0000${occurrence.path}`)
    let resolution: RefResolution
    if (!parsed) resolution = { kind: "unresolved", reason: `"${occurrence.ref}" is not a valid reference` }
    else if (decision && "drop" in decision) resolution = { kind: "drop" }
    else if (decision && "invite" in decision) {
      resolution = parsed.area === "people"
        ? { kind: "invite", email: normalizeEmail(parsed.target) }
        : { kind: "unresolved", reason: "only people can be invited" }
    } else if (decision && "targetId" in decision) {
      const known = parsed.area === "people"
        ? memberIds.has(decision.targetId)
        : !input.targetItems.has(parsed.area) || (input.targetItems.get(parsed.area) ?? []).some((item) => item.id === decision.targetId)
      resolution = known
        ? { kind: "target", id: decision.targetId, via: "decision" }
        : { kind: "unresolved", reason: `chosen target ${decision.targetId} does not exist` }
    } else resolution = resolveAuto(parsed.area, parsed.target, occurrence.name)
    return { ...occurrence, resolution }
  }
}

export function toPlanRef(occurrence: ResolvedRefOccurrence): ConfigPlanRef {
  const base: ConfigPlanRef = { path: occurrence.path, ref: occurrence.ref, resolvedId: null, via: null }
  if (occurrence.name !== undefined) base.name = occurrence.name
  const { resolution } = occurrence
  switch (resolution.kind) {
    case "target":
      return { ...base, resolvedId: resolution.id, via: resolution.via }
    case "planned":
      return { ...base, via: "planned" }
    case "drop":
      return { ...base, via: "decision", decision: "drop" }
    case "invite":
      return { ...base, via: "decision", decision: "invite" }
    case "unresolved":
      return base
  }
}

/**
 * The blob spec as it would be written, for diffing against the target:
 * refs resolved to an existing item become `<area>/<local id>` (people keep
 * their email), dropped refs are removed, others are left as written.
 */
export function localizeSpec(spec: { [key: string]: unknown }, resolved: readonly ResolvedRefOccurrence[]): { [key: string]: unknown } {
  const byPath = new Map(resolved.map((occurrence) => [occurrence.path, occurrence]))
  const out = rewriteRefs(spec, (path, ref) => {
    const occurrence = byPath.get(path)
    if (!occurrence) return ref
    const { resolution } = occurrence
    if (resolution.kind === "drop") return DROP_REF
    if (resolution.kind !== "target") return ref
    const parsed = parseConfigRef(ref.$ref)
    if (!parsed || parsed.area === "people") return ref
    return { ...ref, $ref: `${parsed.area}/${resolution.id}` }
  })
  return isPlainObject(out) ? out : {}
}
