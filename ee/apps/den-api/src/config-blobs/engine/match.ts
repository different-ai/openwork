/**
 * One-to-one matching of blob items to target items within one area
 * (mapping.md › Match tiers). Tiers 1–5 are identity checks and match
 * automatically; tier 6 ("proposed") only ever produces suggestions and
 * flags the item `needs_mapping`.
 *
 * Pass order: explicit decisions first (an admin's choice beats everything),
 * then id, alias, key, natural key, proposed. Each pass sees only the items
 * still unmatched on both sides, so a lower tier never steals a target that
 * a higher tier matched.
 */
import type {
  ConfigBlobItem,
  ConfigMatchCandidate,
  ConfigMatchTier,
  ConfigPlanFlag,
} from "@openwork/types/den/config-blobs"
import { isConfigRef, isConfigSecret } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigItem } from "../area.js"
import { stringifyCanonical } from "./canonical.js"
import { isPlainObject, joinPath } from "./util.js"

/** Lowest score shown as a candidate. */
export const PROPOSE_THRESHOLD = 0.35
/** A candidate is preselected only at or above this score… */
export const SUGGEST_MIN_SCORE = 0.85
/** …and this far ahead of the next one. */
export const SUGGEST_MIN_LEAD = 0.15
const MAX_CANDIDATES = 5

export type ItemMatch = {
  index: number
  /** Stable handle: blob id, else `key:<key>`, else `#<index>`. */
  ref: string
  blob: ConfigBlobItem
  target: ConfigItem | null
  matchedBy: ConfigMatchTier | null
  flags: ConfigPlanFlag[]
  reasons: string[]
  candidates?: ConfigMatchCandidate[]
  /** Tier 6: the candidate the UI should preselect, when one is clearly ahead. Never applied. */
  suggestedTargetId?: string
  /** The admin chose "create new item" for this blob item. */
  decidedCreate?: boolean
}

export type AreaMatchInput = {
  area: Pick<ConfigArea, "key" | "naturalKeys" | "similarity">
  blobItems: readonly ConfigBlobItem[]
  targetItems: readonly ConfigItem[]
  /** Source id → local id, for this area and the blob's source instance. */
  aliases?: ReadonlyMap<string, string>
  /** Confirmed matches for this area (`ConfigDecisions.matches`). */
  decisions?: ReadonlyArray<{ ref: string; targetId: string }>
}

export type AreaMatchResult = {
  matches: ItemMatch[]
  /** Target items no blob item matched (proposed suggestions do not count as matched). */
  unmatchedTargets: ConfigItem[]
  /** Validation errors (duplicate id / key). When non-empty the upload must be rejected. */
  errors: string[]
}

export function blobItemRef(item: Pick<ConfigBlobItem, "id" | "key">, index: number): string {
  if (item.id) return item.id
  if (item.key) return `key:${item.key}`
  return `#${index}`
}

/** A blob item seen as a `ConfigItem` (for natural keys, similarity and unique fields). */
export function blobItemAsConfigItem(item: ConfigBlobItem, index: number): ConfigItem {
  return { id: item.id ?? blobItemRef(item, index), key: item.key ?? null, name: item.name, spec: item.spec }
}

/** Duplicate ids or keys inside one blob area are a validation error. */
export function validateBlobItems(areaKey: string, items: readonly ConfigBlobItem[]): string[] {
  const errors: string[] = []
  const ids = new Map<string, number>()
  const keys = new Map<string, number>()
  items.forEach((item, index) => {
    if (item.id) {
      const first = ids.get(item.id)
      if (first !== undefined) errors.push(`${areaKey}: items #${first} and #${index} have the same id "${item.id}"`)
      else ids.set(item.id, index)
    }
    if (item.key) {
      const first = keys.get(item.key)
      if (first !== undefined) errors.push(`${areaKey}: items #${first} and #${index} have the same key "${item.key}"`)
      else keys.set(item.key, index)
    }
  })
  return errors
}

export function matchArea(input: AreaMatchInput): AreaMatchResult {
  const { area, blobItems, targetItems } = input
  const errors = validateBlobItems(area.key, blobItems)
  const targetsById = new Map(targetItems.map((item) => [item.id, item]))
  const taken = new Set<string>()
  const matches: ItemMatch[] = blobItems.map((blob, index) => ({
    index,
    ref: blobItemRef(blob, index),
    blob,
    target: null,
    matchedBy: null,
    flags: [],
    reasons: [],
  }))
  const decided = new Set<number>()
  const isOpen = (match: ItemMatch) => match.target === null && !decided.has(match.index)
  const claim = (match: ItemMatch, target: ConfigItem, tier: ConfigMatchTier, reason?: string) => {
    match.target = target
    match.matchedBy = tier
    taken.add(target.id)
    if (reason) match.reasons.push(reason)
  }

  // Tier 3, run first: an admin's confirmed choice.
  const decisionsByRef = new Map((input.decisions ?? []).map((decision) => [decision.ref, decision.targetId]))
  for (const match of matches) {
    const targetId = decisionsByRef.get(match.ref)
    if (targetId === undefined) continue
    decided.add(match.index)
    if (targetId === "create") {
      match.matchedBy = "decision"
      match.decidedCreate = true
      match.reasons.push("create new item (confirmed)")
      continue
    }
    const target = targetsById.get(targetId)
    if (!target || taken.has(targetId)) {
      match.flags.push("needs_mapping")
      match.reasons.push(target ? `confirmed target ${targetId} is already matched to another item` : `confirmed target ${targetId} no longer exists`)
      continue
    }
    const tier: ConfigMatchTier = match.blob.id === targetId ? "id" : match.blob.id && input.aliases?.get(match.blob.id) === targetId ? "alias" : "decision"
    claim(match, target, tier, tier === "decision" ? "confirmed match" : undefined)
  }

  // Tier 1: id.
  for (const match of matches) {
    if (!isOpen(match) || !match.blob.id) continue
    const target = targetsById.get(match.blob.id)
    if (target && !taken.has(target.id)) claim(match, target, "id")
  }

  // Tier 2: alias.
  for (const match of matches) {
    if (!isOpen(match) || !match.blob.id) continue
    const localId = input.aliases?.get(match.blob.id)
    const target = localId ? targetsById.get(localId) : undefined
    if (target && !taken.has(target.id)) claim(match, target, "alias")
  }

  // Identity conflict: id/alias says A, key says B.
  for (const match of matches) {
    if (!match.target || decided.has(match.index) || (match.matchedBy !== "id" && match.matchedBy !== "alias") || !match.blob.key) continue
    const byKey = targetItems.find((item) => item.key === match.blob.key)
    if (byKey && byKey.id !== match.target.id) {
      match.flags.push("conflict.identity")
      match.reasons.push(`${match.matchedBy} matches "${match.target.name}" but key "${match.blob.key}" matches "${byKey.name}"`)
      match.candidates = [
        { id: match.target.id, name: match.target.name, score: 1, reasons: [`same ${match.matchedBy}`] },
        { id: byKey.id, name: byKey.name, score: 1, reasons: ["same key"] },
      ]
    }
  }

  // Tier 4: key.
  for (const match of matches) {
    if (!isOpen(match) || !match.blob.key) continue
    const target = targetItems.find((item) => !taken.has(item.id) && item.key === match.blob.key)
    if (target) claim(match, target, "key")
  }

  // Tier 5: natural keys, only when the value is unique on both sides among unmatched items.
  for (const naturalKey of area.naturalKeys) {
    const blobByValue = new Map<string, ItemMatch[]>()
    for (const match of matches) {
      if (!isOpen(match)) continue
      const value = naturalKey.get(blobItemAsConfigItem(match.blob, match.index))
      if (value === null) continue
      blobByValue.set(value, [...(blobByValue.get(value) ?? []), match])
    }
    const targetByValue = new Map<string, ConfigItem[]>()
    for (const item of targetItems) {
      if (taken.has(item.id)) continue
      const value = naturalKey.get(item)
      if (value === null) continue
      targetByValue.set(value, [...(targetByValue.get(value) ?? []), item])
    }
    for (const [value, blobs] of blobByValue) {
      const targets = targetByValue.get(value)
      if (blobs.length !== 1 || !targets || targets.length !== 1) continue
      claim(blobs[0]!, targets[0]!, "natural", `matched by ${naturalKey.label}`)
    }
  }

  // Tier 6: proposals, never applied.
  for (const match of matches) {
    if (!isOpen(match)) continue
    const blobItem = blobItemAsConfigItem(match.blob, match.index)
    const candidates: ConfigMatchCandidate[] = []
    for (const target of targetItems) {
      if (taken.has(target.id)) continue
      const scored = area.similarity ? area.similarity(blobItem, target) : defaultSimilarity(blobItem, target, area.naturalKeys)
      if (scored.score >= PROPOSE_THRESHOLD) {
        candidates.push({ id: target.id, name: target.name, score: round(scored.score), reasons: scored.reasons })
      }
    }
    if (candidates.length === 0) continue
    candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    match.candidates = candidates.slice(0, MAX_CANDIDATES)
    match.matchedBy = "proposed"
    match.flags.push("needs_mapping")
    const [best, next] = match.candidates
    if (best && best.score >= SUGGEST_MIN_SCORE && best.score - (next?.score ?? 0) >= SUGGEST_MIN_LEAD) {
      match.suggestedTargetId = best.id
      match.reasons.push(`is this the same as "${best.name}"? Suggested (${Math.round(best.score * 100)}%)`)
    } else {
      match.reasons.push("is this new, or the same as an existing item? Confirm to continue")
    }
  }

  return { matches, unmatchedTargets: targetItems.filter((item) => !taken.has(item.id)), errors }
}

// ---------------------------------------------------------------------------
// Default similarity (tier 6)

export function normalizeName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim()
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current.push(Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost))
    }
    previous = current
  }
  return previous[b.length]!
}

/** 0..1: half token Jaccard, half normalized edit distance, on normalized names. */
export function nameSimilarity(a: string, b: string): number {
  const left = normalizeName(a)
  const right = normalizeName(b)
  if (!left && !right) return 1
  const leftTokens = new Set(left.split(" ").filter(Boolean))
  const rightTokens = new Set(right.split(" ").filter(Boolean))
  const union = new Set([...leftTokens, ...rightTokens])
  let shared = 0
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1
  const jaccard = union.size ? shared / union.size : 0
  const longest = Math.max(left.length, right.length)
  const edit = longest ? 1 - levenshtein(left, right) / longest : 1
  return (jaccard + edit) / 2
}

/** Leaf fields of a spec as `path → canonical value`. Secrets and ref name hints are ignored. */
export function specLeaves(spec: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (isConfigSecret(spec)) return out
  if (isConfigRef(spec)) {
    out.set(path, spec.$ref)
    return out
  }
  if (Array.isArray(spec)) {
    for (const element of spec) {
      const id = isPlainObject(element) && typeof element.id === "string" ? element.id : null
      specLeaves(element, `${path}[${id ?? (isConfigRef(element) ? element.$ref : stringifyCanonical(element))}]`, out)
    }
    return out
  }
  if (isPlainObject(spec)) {
    for (const [key, value] of Object.entries(spec)) specLeaves(value, joinPath(path, key), out)
    return out
  }
  out.set(path, stringifyCanonical(spec))
  return out
}

/** Share of equal leaf fields over the union of leaf paths. */
export function specOverlap(a: unknown, b: unknown): { score: number; equal: number; total: number } {
  const left = specLeaves(a)
  const right = specLeaves(b)
  const paths = new Set([...left.keys(), ...right.keys()])
  let equal = 0
  for (const path of paths) if (left.has(path) && left.get(path) === right.get(path)) equal += 1
  return { score: paths.size ? equal / paths.size : 0, equal, total: paths.size }
}

export function defaultSimilarity(
  blob: ConfigItem,
  target: ConfigItem,
  naturalKeys: ConfigArea["naturalKeys"] = [],
): { score: number; reasons: string[] } {
  const reasons: string[] = []
  const name = nameSimilarity(blob.name, target.name)
  if (normalizeName(blob.name) === normalizeName(target.name)) reasons.push("same name")
  else if (name >= 0.6) reasons.push("similar name")
  const overlap = specOverlap(blob.spec, target.spec)
  if (overlap.total > 0 && overlap.equal > 0) reasons.push(`${overlap.equal}/${overlap.total} fields equal`)
  let bonus = 0
  for (const naturalKey of naturalKeys) {
    const value = naturalKey.get(blob)
    if (value !== null && value === naturalKey.get(target)) {
      bonus = 0.15
      reasons.push(`same ${naturalKey.label}`)
    }
  }
  // A couple of equal empty-ish fields say little: overlap counts fully from 3 equal leaves.
  const confidence = Math.min(1, overlap.equal / 3)
  return { score: Math.min(1, 0.55 * name + 0.45 * overlap.score * confidence + bonus), reasons }
}

function round(score: number): number {
  return Math.round(score * 1000) / 1000
}
