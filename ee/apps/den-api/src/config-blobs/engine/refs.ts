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
import { isPlainObject, isUnsafeKey, joinPath, normalizeEmail } from "./util.js"

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
/** Removes the array element the reference sits in, however deep in it (`access[2].member`: all of `access[2]`). */
export const DROP_ENTRY: unique symbol = Symbol("drop-entry")

/** The schema path of a positional one: `access[2].member` → `access[].member`. */
export function refSchemaPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]")
}

/**
 * Copies `spec`, replacing every `$ref` with what `replace` returns for it
 * (`DROP_REF` removes it; inside an array the element is removed. `DROP_ENTRY`
 * removes the nearest array element around it; with no array around it, it is
 * the result).
 */
export function rewriteRefs(spec: unknown, replace: (path: string, ref: ConfigRef) => unknown, path = ""): unknown {
  if (isConfigRef(spec)) return replace(path, spec)
  if (isConfigSecret(spec)) return spec
  if (Array.isArray(spec)) {
    const out: unknown[] = []
    spec.forEach((element, index) => {
      const next = rewriteRefs(element, replace, `${path}[${index}]`)
      if (next !== DROP_REF && next !== DROP_ENTRY) out.push(next)
    })
    return out
  }
  if (isPlainObject(spec)) {
    const out: { [key: string]: unknown } = {}
    for (const [key, value] of Object.entries(spec)) {
      if (isUnsafeKey(key)) continue
      const next = rewriteRefs(value, replace, joinPath(path, key))
      if (next === DROP_ENTRY) return DROP_ENTRY
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
  /** `entry`: the reference is one its array element can't exist without (`requiredRefs`), so the element goes with it. */
  | { kind: "drop"; entry?: true }
  /**
   * The admin chose to invite someone who is neither a member nor a person in
   * the blob: the plan adds a `members.people` create (`inviteRef(email)`)
   * and the reference resolves to it at execute time.
   */
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
  /** Area definitions, for natural keys of out-of-scope lookups and the references an item's entries can't lose. */
  areas: ReadonlyMap<ConfigAreaKey, Pick<ConfigArea, "naturalKeys" | "requiredRefs">>
  aliases?: ReadonlyMap<ConfigAreaKey, ReadonlyMap<string, string>>
  /** Target org members by normalized email → member id. */
  people?: ReadonlyMap<string, string>
  decisions?: ConfigDecisions["refs"]
  /** Whether an `invite` decision can be planned (the `members.people` area is available). Default false. */
  canInvite?: boolean
}

export const PEOPLE_AREA: ConfigAreaKey = "members.people"

/**
 * Set on the spec of a `members.people` create when the admin chose to send
 * invitation emails (`decisions.people.sendInviteEmails`). Absent or false: silent.
 */
export const SEND_INVITE_EMAIL_FIELD = "__sendInviteEmail"

/**
 * Whether a `people/…` handle is an email. The other form is a member id
 * (`people/om_…`, exports for callers who may not read emails): it resolves
 * only to a member of the target organization and can't be invited.
 */
export function isEmailHandle(handle: string): boolean {
  return handle.includes("@")
}

/** Plan ref of the `members.people` create an invite decision adds. */
export function inviteRef(email: string): string {
  return `invite:${normalizeEmail(email)}`
}

/** The area a reference points into (`people/…` → `members.people`), or null when it is not a valid reference. */
export function refArea(ref: string): ConfigAreaKey | null {
  const parsed = parseConfigRef(ref)
  if (!parsed) return null
  return parsed.area === "people" ? PEOPLE_AREA : parsed.area
}

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

  // Indexes, built once per area on first use, so resolving a reference is a
  // few map lookups rather than a scan of every item.
  type TargetIndex = { ids: Map<string, ConfigItem>; keys: Map<string, ConfigItem>; natural: Map<string, Map<string, ConfigItem[]>> }
  const targetIndexes = new Map<ConfigAreaKey, TargetIndex>()
  const targetIndex = (area: ConfigAreaKey): TargetIndex => {
    const cached = targetIndexes.get(area)
    if (cached) return cached
    const items = input.targetItems.get(area) ?? []
    const index: TargetIndex = { ids: new Map(), keys: new Map(), natural: new Map() }
    for (const item of items) {
      if (!index.ids.has(item.id)) index.ids.set(item.id, item)
      if (item.key && !index.keys.has(item.key)) index.keys.set(item.key, item)
    }
    targetIndexes.set(area, index)
    return index
  }
  const naturalIndex = (area: ConfigAreaKey, naturalKey: Pick<ConfigArea, "naturalKeys">["naturalKeys"][number]): Map<string, ConfigItem[]> => {
    const index = targetIndex(area)
    const cached = index.natural.get(naturalKey.label)
    if (cached) return cached
    const byValue = new Map<string, ConfigItem[]>()
    for (const item of input.targetItems.get(area) ?? []) {
      const value = naturalKey.get(item)
      if (value === null) continue
      const list = byValue.get(value)
      if (list) list.push(item)
      else byValue.set(value, [item])
    }
    index.natural.set(naturalKey.label, byValue)
    return byValue
  }
  const blobIndexes = new Map<ConfigAreaKey, Map<string, ItemMatch>>()
  const blobIndex = (area: ConfigAreaKey): Map<string, ItemMatch> => {
    const cached = blobIndexes.get(area)
    if (cached) return cached
    const index = new Map<string, ItemMatch>()
    // Same precedence as before: the first item whose id, key or ref equals the handle.
    for (const match of input.blobMatches.get(area) ?? []) {
      for (const handle of [match.blob.id, match.blob.key, match.ref]) if (handle && !index.has(handle)) index.set(handle, match)
    }
    blobIndexes.set(area, index)
    return index
  }
  let peopleIndex: Map<string, ItemMatch> | null = null
  const blobPerson = (email: string): ItemMatch | undefined => {
    if (!input.scope.has(PEOPLE_AREA)) return undefined
    if (!peopleIndex) {
      peopleIndex = new Map()
      for (const candidate of input.blobMatches.get(PEOPLE_AREA) ?? []) {
        const value = candidate.blob.spec.email
        if (typeof value !== "string") continue
        const normalized = normalizeEmail(value)
        if (!peopleIndex.has(normalized)) peopleIndex.set(normalized, candidate)
      }
    }
    return peopleIndex.get(email)
  }

  const lookupTarget = (area: ConfigAreaKey, handle: string, hint: string | undefined): RefResolution => {
    const index = targetIndex(area)
    const byId = index.ids.get(handle)
    if (byId) return { kind: "target", id: byId.id, via: "target" }
    const aliased = input.aliases?.get(area)?.get(handle)
    const byAlias = aliased ? index.ids.get(aliased) : undefined
    if (byAlias) return { kind: "target", id: byAlias.id, via: "target" }
    const byKey = index.keys.get(handle)
    if (byKey) return { kind: "target", id: byKey.id, via: "target" }
    const naturalKeys = input.areas.get(area)?.naturalKeys ?? []
    if (hint !== undefined) {
      const probe: ConfigItem = { id: handle, key: null, name: hint, spec: {} }
      for (const naturalKey of naturalKeys) {
        const value = naturalKey.get(probe)
        if (value === null) continue
        const hits = naturalIndex(area, naturalKey).get(value) ?? []
        if (hits.length === 1) return { kind: "target", id: hits[0]!.id, via: "target" }
        if (hits.length > 1) return { kind: "unresolved", reason: `${hits.length} ${area} items share ${naturalKey.label} "${hint}": choose one` }
      }
    }
    return { kind: "unresolved", reason: `no ${area} item "${hint ?? handle}" on this organization` }
  }

  const resolveAuto = (area: ConfigAreaKey | "people", handle: string, hint: string | undefined): RefResolution => {
    if (area === "people") {
      if (!isEmailHandle(handle)) {
        if (memberIds.has(handle)) return { kind: "target", id: handle, via: "target" }
        return { kind: "unresolved", reason: `person ${handle} is not a member of this organization: choose a member or drop them` }
      }
      const email = normalizeEmail(handle)
      const memberId = input.people?.get(email)
      if (memberId) return { kind: "target", id: memberId, via: "target" }
      const match = blobPerson(email)
      if (match) return fromBlobMatch(PEOPLE_AREA, match)
      return { kind: "unresolved", reason: `${handle} is not a member of this organization: invite them or drop them` }
    }
    if (input.scope.has(area)) {
      const match = blobIndex(area).get(handle)
      if (match) return fromBlobMatch(area, match)
    }
    return lookupTarget(area, handle, hint)
  }

  /**
   * An invite decision. Someone already a member, or a person this blob
   * creates, resolves as usual (the invite is moot); anyone else becomes a
   * planned `members.people` create, never a bare `invite` handed to an adapter.
   */
  const resolveInvite = (parsed: { area: ConfigAreaKey | "people"; target: string }, hint: string | undefined): RefResolution => {
    if (parsed.area !== "people") return { kind: "unresolved", reason: "only people can be invited" }
    if (!isEmailHandle(parsed.target)) {
      const byId = resolveAuto("people", parsed.target, hint)
      return byId.kind === "target" ? byId : { kind: "unresolved", reason: `person ${parsed.target} can't be invited without an email: choose a member or drop them` }
    }
    const email = normalizeEmail(parsed.target)
    const auto = resolveAuto("people", parsed.target, hint)
    // A person in the blob that was skipped stays unresolved: inviting them anyway would undo the skip.
    if (auto.kind !== "unresolved" || blobPerson(email)) return auto
    if (!input.canInvite) return { kind: "unresolved", reason: `${email} can't be invited here: choose a member or drop them` }
    return { kind: "invite", email }
  }

  /**
   * A drop decision. On a reference its entry can't exist without (`requiredRefs`) the array element goes with
   * it; one that sits in no array is the item's own, so it can't be dropped and says so.
   */
  const resolveDrop = (itemArea: ConfigAreaKey, parsed: { area: ConfigAreaKey | "people"; target: string }, occurrence: RefOccurrence): RefResolution => {
    const schemaPath = refSchemaPath(occurrence.path)
    if (!(input.areas.get(itemArea)?.requiredRefs ?? []).includes(schemaPath)) return { kind: "drop" }
    if (schemaPath.includes("[]")) return { kind: "drop", entry: true }
    const auto = resolveAuto(parsed.area, parsed.target, occurrence.name)
    return {
      kind: "unresolved",
      reason: auto.kind === "unresolved"
        ? `${auto.reason}, and it can't be dropped (this item can't be imported without it): choose one here, or skip the item`
        : "it can't be dropped (this item can't be imported without it): remove that decision, or skip the item",
    }
  }

  return (itemArea, itemRef, occurrence) => {
    const parsed = parseConfigRef(occurrence.ref)
    const decision = decisions.get(`${itemArea}\u0000${itemRef}\u0000${occurrence.path}`)
    let resolution: RefResolution
    if (!parsed) resolution = { kind: "unresolved", reason: `"${occurrence.ref}" is not a valid reference` }
    else if (decision && "drop" in decision) resolution = resolveDrop(itemArea, parsed, occurrence)
    else if (decision && "invite" in decision) resolution = resolveInvite(parsed, occurrence.name)
    else if (decision && "targetId" in decision) {
      const loaded = parsed.area === "people" ? input.people !== undefined : input.targetItems.has(parsed.area)
      const known = parsed.area === "people"
        ? memberIds.has(decision.targetId)
        : (input.targetItems.get(parsed.area) ?? []).some((item) => item.id === decision.targetId)
      resolution = !loaded
        ? { kind: "unresolved", reason: `${parsed.area} can't be checked here, so a chosen item can't be used` }
        : known
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
      return { ...base, via: "planned", decision: "invite" }
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
    if (resolution.kind === "drop") return resolution.entry ? DROP_ENTRY : DROP_REF
    if (resolution.kind !== "target") return ref
    const parsed = parseConfigRef(ref.$ref)
    if (!parsed || parsed.area === "people") return ref
    return { ...ref, $ref: `${parsed.area}/${resolution.id}` }
  })
  return isPlainObject(out) ? out : {}
}
