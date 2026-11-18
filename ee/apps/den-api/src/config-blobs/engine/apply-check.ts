/**
 * What apply reads, kept to the items it writes (change-requests.md › Apply):
 * - `readItemsFor`: one helper for "read these ids" (`area.readItems`, else
 *   the area's export filtered);
 * - `checkWrittenItems`: re-reads every item an update or delete writes and
 *   compares its `itemRev` with the plan's `targetRev`; checks the targets of
 *   resolved references (other than people) still exist; for creates and renames on areas with
 *   unique fields, checks nothing now collides (the only case that exports
 *   an area, because uniqueness is about every item). Any mismatch is drift:
 *   the caller marks the request stale, exactly as a changed plan hash did.
 * The fresh items replace each op's `previous` and are the before-snapshot.
 */
import type { ConfigAreaKey } from "@openwork/types/den/config-blobs"
import { parseConfigRef } from "@openwork/types/den/config-blobs"
import type { ConfigArea, ConfigAreaContext, ConfigItem } from "../area.js"
import { itemRev } from "./canonical.js"
import type { ExecutionOp, ExecutionPlan } from "./plan.js"

/** One read apply made, for tests and logs: `read` = only these ids, `export` = the whole area. */
export type ApplyRead = { area: ConfigAreaKey; kind: "read" | "export"; ids: number }

/** Only these items of the area (missing ids are absent). */
export async function readItemsFor(area: ConfigArea, ctx: ConfigAreaContext, ids: readonly string[], reads?: ApplyRead[]): Promise<ConfigItem[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  if (area.readItems) {
    reads?.push({ area: area.key, kind: "read", ids: unique.length })
    return area.readItems(ctx, unique)
  }
  reads?.push({ area: area.key, kind: "export", ids: unique.length })
  const wanted = new Set(unique)
  return (await area.exportItems(ctx)).filter((item) => wanted.has(item.id))
}

export type WrittenItemsCheck = {
  /** Why the plan no longer holds, one line per item. Empty: go ahead. */
  problems: string[]
  /** The plan with each update's and delete's `previous` replaced by the item as read now. */
  execution: ExecutionPlan
  /** The current state of every item an update or delete writes, per area: the before-snapshot. */
  before: Map<ConfigAreaKey, ConfigItem[]>
  reads: ApplyRead[]
}

/**
 * The area a resolved reference's target is re-read from. People references
 * are not re-checked: they resolve to members through the people lookup, and
 * re-reading them would mean reading every member; a removed member makes the
 * adapter's write fail instead, and the report says where.
 */
function refTargetArea(ref: string): ConfigAreaKey | null {
  const parsed = parseConfigRef(ref)
  return parsed && parsed.area !== "people" ? parsed.area : null
}

function writes(op: ExecutionOp): boolean {
  return op.kind === "update" || op.kind === "delete"
}

export async function checkWrittenItems(execution: ExecutionPlan, areas: readonly ConfigArea[], ctx: ConfigAreaContext): Promise<WrittenItemsCheck> {
  const areaByKey = new Map(areas.map((area) => [area.key, area]))
  const reads: ApplyRead[] = []
  const problems: string[] = []
  const label = (key: ConfigAreaKey) => areaByKey.get(key)?.label ?? key

  // Ids to read per area: written items, and the targets references resolved to.
  const wanted = new Map<ConfigAreaKey, Set<string>>()
  const want = (key: ConfigAreaKey, id: string) => {
    const ids = wanted.get(key) ?? new Set<string>()
    ids.add(id)
    wanted.set(key, ids)
  }
  for (const op of execution.ops) {
    if (writes(op) && op.targetId) want(op.area, op.targetId)
    for (const ref of op.refs) {
      if (ref.resolution.kind !== "target") continue
      const key = refTargetArea(ref.ref)
      if (key && areaByKey.has(key)) want(key, ref.resolution.id)
    }
  }
  const current = new Map<string, ConfigItem>()
  for (const [key, ids] of wanted) {
    const area = areaByKey.get(key)
    if (!area) continue
    for (const item of await readItemsFor(area, ctx, [...ids], reads)) current.set(`${key}\u0000${item.id}`, item)
  }

  const before = new Map<ConfigAreaKey, ConfigItem[]>()
  const ops: ExecutionOp[] = []
  for (const op of execution.ops) {
    const area = areaByKey.get(op.area)
    if (!area) {
      problems.push(`${op.area} is not available on this server`)
      ops.push(op)
      continue
    }
    let next = op
    if (writes(op) && op.targetId) {
      const now = current.get(`${op.area}\u0000${op.targetId}`)
      if (!now) problems.push(`${label(op.area)} "${op.name}" no longer exists`)
      else {
        if (op.targetRev !== undefined && itemRev(area, now) !== op.targetRev) problems.push(`${label(op.area)} "${op.name}" changed since the plan was made`)
        next = { ...op, previous: now }
        const list = before.get(op.area) ?? []
        if (!list.some((item) => item.id === now.id)) list.push(now)
        before.set(op.area, list)
      }
    }
    for (const ref of op.refs) {
      if (ref.resolution.kind !== "target") continue
      const key = refTargetArea(ref.ref)
      if (!key || !wanted.get(key)?.has(ref.resolution.id)) continue
      // A reference to an item this run creates is "planned", not "target"; a delete in this run was refused at plan time.
      if (!current.has(`${key}\u0000${ref.resolution.id}`)) problems.push(`${label(op.area)} "${op.name}": ${ref.path} points at an item that no longer exists`)
    }
    ops.push(next)
  }

  problems.push(...await uniqueCollisions(ops, areaByKey, ctx, reads))
  return { problems, execution: { ...execution, ops }, before, reads }
}

/** Creates and renames on areas with unique fields: does anything on the target now hold the same value? */
async function uniqueCollisions(ops: readonly ExecutionOp[], areaByKey: ReadonlyMap<ConfigAreaKey, ConfigArea>, ctx: ConfigAreaContext, reads: ApplyRead[]): Promise<string[]> {
  const problems: string[] = []
  const byArea = new Map<ConfigAreaKey, ExecutionOp[]>()
  for (const op of ops) byArea.set(op.area, [...(byArea.get(op.area) ?? []), op])
  for (const [key, areaOps] of byArea) {
    const area = areaByKey.get(key)
    const uniques = area?.uniqueFields ?? []
    if (!area || uniques.length === 0) continue
    const probes = areaOps.filter((op) => {
      if (!op.item) return false
      if (op.kind === "create") return true
      if (op.kind !== "update" || !op.previous) return false
      const previous = op.previous
      const item = op.item
      return uniques.some((unique) => unique.get(item) !== unique.get(previous))
    })
    if (probes.length === 0) continue
    reads.push({ area: key, kind: "export", ids: 0 })
    const rewritten = new Set(areaOps.flatMap((op) => (op.targetId ? [op.targetId] : [])))
    const staying = (await area.exportItems(ctx)).filter((item) => !rewritten.has(item.id))
    for (const unique of uniques) {
      const taken = new Set(staying.flatMap((item) => {
        const value = unique.get(item)
        return value === null ? [] : [value]
      }))
      for (const op of probes) {
        if (!op.item) continue
        const value = unique.get(op.item)
        if (value !== null && taken.has(value)) problems.push(`${area.label} "${op.name}": another item now has ${unique.label} "${value}"`)
      }
    }
  }
  return problems
}
