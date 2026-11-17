/**
 * Runs an execution plan through the area adapters, in order
 * (change-requests.md › Apply, step 3). Locking, snapshots, run rows and
 * alias writes are the caller's job; this resolves each op's item, calls
 * `area.apply` and keeps a per-item report the caller can persist after every
 * item (`onProgress`).
 *
 * What an adapter receives:
 * - every `$ref` gets `id`: the local target id (existing item, or the id a
 *   planned create in this run produced);
 * - refs with a `drop` decision are removed (from arrays: the element);
 * - people refs with an `invite` decision get the `id` of the
 *   `members.people` create the plan added for them (it runs first), so an
 *   adapter never sees a reference without an id;
 * - every `$secret` becomes a `ResolvedConfigSecret` (keep / value / unset).
 *   `env` decisions must be resolved by the caller into `value` secrets. A
 *   supplied value is bound to one placeholder: the op must hold a `value` or
 *   `env` decision for that exact path, and a path is used at most once per
 *   run (`buildPlan` already refuses blobs that repeat a `$secret` path);
 * - an update carries the plan's field `changes` and the `secretPaths` whose
 *   decision writes a credential. An update with neither is never sent: it is
 *   reported `noop`.
 *
 * No transaction: each adapter writes through the domain services, which
 * commit per item. The report (what was written, where it stopped) and the
 * before-snapshot are the safety net (change-requests.md › Apply).
 */
import type {
  ConfigApplyFailure,
  ConfigApplyItemStatus,
  ConfigApplyReportItem,
  ConfigAreaKey,
  ConfigSpec,
  ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { isConfigSecret } from "@openwork/types/den/config-blobs"
import { ConfigApplyItemError, type ConfigApplyOp, type ConfigArea, type ConfigAreaContext, type ResolvedConfigItem } from "../area.js"
import type { ExecutionOp, ExecutionPlan } from "./plan.js"
import { DROP_ENTRY, DROP_REF, PEOPLE_AREA, inviteRef, rewriteRefs } from "./refs.js"
import { isPlainObject, isUnsafeKey } from "./util.js"

export type ExecuteOptions = {
  /**
   * Whether `id` is unused on the whole instance for a create in `area`;
   * creates reuse the source id when it is (D4). Without it, no id is reused.
   */
  isIdFree?: (id: string, area: ConfigAreaKey) => Promise<boolean>
  /**
   * Called (and awaited) after an item starts and after it ends, with the
   * whole report so far: the caller persists it, so a crash leaves an
   * accurate partial report. Its failures are the caller's to swallow.
   */
  onProgress?: (items: readonly ConfigApplyReportItem[]) => Promise<void>
  /** Failure for an error that is not a ConfigApplyItemError (the caller redacts). Default: code "error" and the message. */
  describeError?: (error: unknown) => ConfigApplyFailure
  /** Clock, for tests. */
  now?: () => number
}

export type ExecuteResult = {
  ok: boolean
  items: ConfigApplyReportItem[]
  warnings: string[]
  /** Every create that ran. */
  created: Array<{ area: ConfigAreaKey; ref: string; sourceId?: string; localId: string }>
  /** Alias rows to write: creates that could not keep their source id, and confirmed matches to a different id. */
  aliases: Array<{ area: ConfigAreaKey; sourceId: string; localId: string }>
}

export function emptyApplyCounts(): Record<ConfigApplyItemStatus, number> {
  return { applied: 0, noop: 0, failed: 0, not_reached: 0, skipped: 0 }
}

export function countApplyItems(items: readonly Pick<ConfigApplyReportItem, "status">[]): Record<ConfigApplyItemStatus, number> {
  const counts = emptyApplyCounts()
  for (const item of items) counts[item.status] += 1
  return counts
}

/** The report items of a plan before anything ran: every op `not_reached`. */
export function pendingReportItems(execution: ExecutionPlan): ConfigApplyReportItem[] {
  return execution.ops.map((op) => ({
    area: op.area,
    ref: op.ref,
    name: op.name,
    op: op.op,
    localId: op.targetId ?? null,
    status: "not_reached",
    steps: [],
    warnings: [],
    irreversible: [...op.irreversible],
    startedAt: null,
    durationMs: null,
  }))
}

function defaultFailure(error: unknown): ConfigApplyFailure {
  return { code: "error", message: error instanceof Error ? error.message : String(error) }
}

/** An update that would write nothing: no field changes and no credential to store. */
export function isNoopUpdate(op: Pick<ExecutionOp, "kind" | "changes" | "secretPaths">): boolean {
  return op.kind === "update" && op.changes.length === 0 && op.secretPaths.length === 0
}

export async function executePlan(
  execution: ExecutionPlan,
  areas: readonly ConfigArea[],
  ctx: ConfigAreaContext,
  secrets: ReadonlyMap<string, ResolvedConfigSecret>,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const now = opts.now ?? Date.now
  const describe = opts.describeError ?? defaultFailure
  const items = pendingReportItems(execution)
  const result: ExecuteResult = { ok: true, items, warnings: [], created: [], aliases: [] }
  if (execution.blocking > 0) {
    result.ok = false
    result.warnings.push(`the plan has ${execution.blocking} blocking item(s): nothing was applied`)
    for (const item of items) item.status = "skipped"
    return result
  }
  const progress = async () => {
    if (opts.onProgress) await opts.onProgress(items)
  }
  const areaByKey = new Map(areas.map((area) => [area.key, area]))
  /** `${area}\u0000${blob ref}` → local id of creates done in this run. */
  const planned = new Map<string, string>()
  /** Secret paths whose supplied value an op already received: a value goes into one placeholder only. */
  const usedSecrets = new Set<string>()
  for (const [index, op] of execution.ops.entries()) {
    const entry = items[index]
    if (!entry) continue
    const started = now()
    entry.startedAt = new Date(started).toISOString()
    if (isNoopUpdate(op)) {
      entry.status = "noop"
      entry.irreversible = []
      entry.durationMs = 0
      await progress()
      continue
    }
    try {
      const area = areaByKey.get(op.area)
      if (!area) throw new Error(`area ${op.area} is not available`)
      const applyOp = await toApplyOp(op, planned, secrets, usedSecrets, opts)
      if (area.irreversible) entry.irreversible = safeIrreversible(area, applyOp) ?? entry.irreversible
      await progress()
      const applied = await area.apply(ctx, applyOp)
      entry.localId = applied.localId
      entry.warnings = applied.warnings ?? []
      entry.steps = applied.steps ?? []
      // An adapter that reports steps and wrote none found nothing to do after all.
      entry.status = applied.steps !== undefined && applied.steps.length === 0 ? "noop" : "applied"
      if (entry.status === "noop") entry.irreversible = []
      entry.durationMs = now() - started
      if (op.kind === "create") {
        planned.set(`${op.area}\u0000${op.ref}`, applied.localId)
        const sourceId = op.item?.sourceId
        result.created.push(sourceId ? { area: op.area, ref: op.ref, sourceId, localId: applied.localId } : { area: op.area, ref: op.ref, localId: applied.localId })
        if (sourceId && sourceId !== applied.localId) result.aliases.push({ area: op.area, sourceId, localId: applied.localId })
      } else if (op.kind === "update" && op.matchedBy === "decision" && op.item?.sourceId && op.item.sourceId !== applied.localId) {
        result.aliases.push({ area: op.area, sourceId: op.item.sourceId, localId: applied.localId })
      }
      await progress()
    } catch (error) {
      result.ok = false
      entry.status = "failed"
      entry.durationMs = now() - started
      if (error instanceof ConfigApplyItemError) {
        entry.failure = error.failure
        entry.steps = [...error.stepsDone]
      } else {
        entry.failure = describe(error)
      }
      // Effects only count once something was written for the item.
      if (entry.steps.length === 0) entry.irreversible = []
      await progress()
      break
    }
  }
  return result
}

function safeIrreversible(area: ConfigArea, op: ConfigApplyOp): string[] | null {
  try {
    return area.irreversible ? area.irreversible(op) : null
  } catch {
    return null
  }
}

async function toApplyOp(
  op: ExecutionOp,
  planned: ReadonlyMap<string, string>,
  secrets: ReadonlyMap<string, ResolvedConfigSecret>,
  usedSecrets: Set<string>,
  opts: ExecuteOptions,
): Promise<ConfigApplyOp> {
  if (op.kind === "delete") {
    if (!op.targetId || !op.previous) throw new Error("delete without a target")
    return { kind: "delete", targetId: op.targetId, previous: op.previous }
  }
  if (!op.item) throw new Error(`${op.kind} without an item`)
  const item: ResolvedConfigItem = { name: op.item.name, spec: resolveSpec(op, op.item.spec, planned, secrets, usedSecrets) }
  if (op.item.sourceId) item.sourceId = op.item.sourceId
  if (op.item.key !== undefined) item.key = op.item.key
  if (op.kind === "update") {
    if (!op.targetId || !op.previous) throw new Error("update without a target")
    return { kind: "update", targetId: op.targetId, item, previous: op.previous, changes: op.changes, secretPaths: op.secretPaths }
  }
  if (op.preferredId && opts.isIdFree && await opts.isIdFree(op.preferredId, op.area)) return { kind: "create", item, preferredId: op.preferredId }
  return { kind: "create", item }
}

/** The op's spec with refs and secrets resolved, as `ResolvedConfigItem.spec`. */
export function resolveSpec(
  op: Pick<ExecutionOp, "refs" | "secrets">,
  spec: ConfigSpec,
  planned: ReadonlyMap<string, string>,
  secrets: ReadonlyMap<string, ResolvedConfigSecret>,
  /** Paths whose supplied value was already placed (shared across a run): a second use throws. */
  usedSecrets: Set<string> = new Set<string>(),
): ConfigSpec {
  const refsByPath = new Map(op.refs.map((ref) => [ref.path, ref]))
  const withRefs = rewriteRefs(spec, (path, ref) => {
    const occurrence = refsByPath.get(path)
    if (!occurrence) throw new Error(`${path}: reference "${ref.$ref}" was not planned`)
    const { resolution } = occurrence
    switch (resolution.kind) {
      case "target":
        return { ...ref, id: resolution.id }
      case "planned": {
        const localId = planned.get(`${resolution.area}\u0000${resolution.ref}`)
        if (!localId) throw new Error(`${path}: "${ref.$ref}" was to be created earlier in this import, but was not`)
        return { ...ref, id: localId }
      }
      case "drop":
        return resolution.entry ? DROP_ENTRY : DROP_REF
      case "invite": {
        const localId = planned.get(`${PEOPLE_AREA}\u0000${inviteRef(resolution.email)}`)
        if (!localId) throw new Error(`${path}: ${resolution.email} was to be invited earlier in this import, but was not`)
        return { ...ref, id: localId }
      }
      case "unresolved":
        throw new Error(`${path}: ${resolution.reason}`)
    }
  })
  // Planning refuses this drop (the reference is the item's own); never write an item emptied by one.
  if (withRefs === DROP_ENTRY) throw new Error("a reference this item can't be imported without was dropped")
  const decisions = new Map<string, ExecutionOp["secrets"][number]>()
  for (const secret of op.secrets) {
    if (decisions.has(secret.path)) throw new Error(`secret ${secret.path}: placed more than once in this item`)
    decisions.set(secret.path, secret)
  }
  const seen = new Set<string>()
  const withSecrets = replaceSecrets(withRefs, (path) => {
    if (seen.has(path)) throw new Error(`secret ${path}: placed more than once in this item`)
    seen.add(path)
    const decision = decisions.get(path)
    if (!decision) throw new Error(`secret ${path}: no decision`)
    if (decision.decision === "value" || decision.decision === "env") {
      // A supplied value only goes where the plan decided to write one, and only once.
      const provided = secrets.get(path)
      if (!provided) throw new Error(`secret ${path}: no value was provided`)
      if (provided.$secret !== path) throw new Error(`secret ${path}: resolved for a different placeholder`)
      if (usedSecrets.has(path)) throw new Error(`secret ${path}: its value was already used for another item`)
      usedSecrets.add(path)
      return provided
    }
    if (decision.decision === "keep") return { $secret: path, decision: "keep" }
    return { $secret: path, decision: "unset" }
  })
  return isPlainObject(withSecrets) ? withSecrets : {}
}

function replaceSecrets(value: unknown, replace: (path: string) => ResolvedConfigSecret): unknown {
  if (isConfigSecret(value)) return replace(value.$secret)
  if (Array.isArray(value)) return value.map((element) => replaceSecrets(element, replace))
  if (isPlainObject(value)) {
    const out: { [key: string]: unknown } = {}
    for (const [key, child] of Object.entries(value)) if (!isUnsafeKey(key)) out[key] = replaceSecrets(child, replace)
    return out
  }
  return value
}

/** The placeholders whose value the caller must supply (`value` inputs, `env` lookups) before `executePlan`. */
export function secretsNeedingValues(execution: ExecutionPlan): Array<{ area: ConfigAreaKey; ref: string; path: string; decision: "value" | "env"; env?: string }> {
  const out: Array<{ area: ConfigAreaKey; ref: string; path: string; decision: "value" | "env"; env?: string }> = []
  for (const op of execution.ops) {
    for (const secret of op.secrets) {
      if (secret.decision === "value") out.push({ area: op.area, ref: op.ref, path: secret.path, decision: "value" })
      else if (secret.decision === "env") out.push(secret.env ? { area: op.area, ref: op.ref, path: secret.path, decision: "env", env: secret.env } : { area: op.area, ref: op.ref, path: secret.path, decision: "env" })
    }
  }
  return out
}
