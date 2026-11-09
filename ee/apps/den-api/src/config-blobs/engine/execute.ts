/**
 * Runs an execution plan through the area adapters, in order
 * (change-requests.md › Apply, step 3). Transactions, locking, snapshots and
 * alias writes are the caller's job; this only resolves each op's item and
 * calls `area.apply`.
 *
 * What an adapter receives:
 * - every `$ref` gets `id`: the local target id (existing item, or the id a
 *   planned create in this run produced);
 * - refs with a `drop` decision are removed (from arrays: the element);
 * - people refs with an `invite` decision get `invite: true` and no `id`:
 *   the people/teams adapter creates the pending invitation;
 * - every `$secret` becomes a `ResolvedConfigSecret` (keep / value / unset).
 *   `env` decisions must be resolved by the caller into `value` secrets.
 */
import type {
  ConfigAreaKey,
  ConfigApplyReport,
  ConfigSpec,
  ResolvedConfigSecret,
} from "@openwork/types/den/config-blobs"
import { isConfigSecret } from "@openwork/types/den/config-blobs"
import type { ConfigApplyOp, ConfigArea, ConfigAreaContext, ResolvedConfigItem } from "../area.js"
import type { ExecutionOp, ExecutionPlan } from "./plan.js"
import { DROP_REF, rewriteRefs } from "./refs.js"
import { isPlainObject } from "./util.js"

export type ExecuteOptions = {
  /** Whether an id is unused on the whole instance; creates reuse the source id when it is (D4). Without it, no id is reused. */
  isIdFree?: (id: string) => Promise<boolean>
}

export type ExecuteResult = ConfigApplyReport & {
  ok: boolean
  /** Every create that ran. */
  created: Array<{ area: ConfigAreaKey; ref: string; sourceId?: string; localId: string }>
  /** Alias rows to write: creates that could not keep their source id, and confirmed matches to a different id. */
  aliases: Array<{ area: ConfigAreaKey; sourceId: string; localId: string }>
}

export async function executePlan(
  execution: ExecutionPlan,
  areas: readonly ConfigArea[],
  ctx: ConfigAreaContext,
  secrets: ReadonlyMap<string, ResolvedConfigSecret>,
  opts: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const result: ExecuteResult = { ok: true, items: [], warnings: [], created: [], aliases: [] }
  if (execution.blocking > 0) {
    result.ok = false
    result.warnings.push(`the plan has ${execution.blocking} blocking item(s): nothing was applied`)
    for (const op of execution.ops) result.items.push({ area: op.area, ref: op.ref, op: op.op, localId: null, status: "skipped", warnings: [] })
    return result
  }
  const areaByKey = new Map(areas.map((area) => [area.key, area]))
  /** `${area}\u0000${blob ref}` → local id of creates done in this run. */
  const planned = new Map<string, string>()
  let failed = false
  for (const op of execution.ops) {
    if (failed) {
      result.items.push({ area: op.area, ref: op.ref, op: op.op, localId: null, status: "skipped", warnings: [] })
      continue
    }
    try {
      const area = areaByKey.get(op.area)
      if (!area) throw new Error(`area ${op.area} is not available`)
      const applyOp = await toApplyOp(op, planned, secrets, opts)
      const applied = await area.apply(ctx, applyOp)
      const warnings = applied.warnings ?? []
      result.items.push({ area: op.area, ref: op.ref, op: op.op, localId: applied.localId, status: "applied", warnings })
      if (op.kind === "create") {
        planned.set(`${op.area}\u0000${op.ref}`, applied.localId)
        const sourceId = op.item?.sourceId
        result.created.push(sourceId ? { area: op.area, ref: op.ref, sourceId, localId: applied.localId } : { area: op.area, ref: op.ref, localId: applied.localId })
        if (sourceId && sourceId !== applied.localId) result.aliases.push({ area: op.area, sourceId, localId: applied.localId })
      } else if (op.kind === "update" && op.matchedBy === "decision" && op.item?.sourceId && op.item.sourceId !== applied.localId) {
        result.aliases.push({ area: op.area, sourceId: op.item.sourceId, localId: applied.localId })
      }
    } catch (error) {
      failed = true
      result.ok = false
      result.items.push({ area: op.area, ref: op.ref, op: op.op, localId: null, status: "failed", warnings: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

async function toApplyOp(
  op: ExecutionOp,
  planned: ReadonlyMap<string, string>,
  secrets: ReadonlyMap<string, ResolvedConfigSecret>,
  opts: ExecuteOptions,
): Promise<ConfigApplyOp> {
  if (op.kind === "delete") {
    if (!op.targetId || !op.previous) throw new Error("delete without a target")
    return { kind: "delete", targetId: op.targetId, previous: op.previous }
  }
  if (!op.item) throw new Error(`${op.kind} without an item`)
  const item: ResolvedConfigItem = { name: op.item.name, spec: resolveSpec(op, op.item.spec, planned, secrets) }
  if (op.item.sourceId) item.sourceId = op.item.sourceId
  if (op.item.key !== undefined) item.key = op.item.key
  if (op.kind === "update") {
    if (!op.targetId || !op.previous) throw new Error("update without a target")
    return { kind: "update", targetId: op.targetId, item, previous: op.previous }
  }
  if (op.preferredId && opts.isIdFree && await opts.isIdFree(op.preferredId)) return { kind: "create", item, preferredId: op.preferredId }
  return { kind: "create", item }
}

/** The op's spec with refs and secrets resolved, as `ResolvedConfigItem.spec`. */
export function resolveSpec(
  op: Pick<ExecutionOp, "refs" | "secrets">,
  spec: ConfigSpec,
  planned: ReadonlyMap<string, string>,
  secrets: ReadonlyMap<string, ResolvedConfigSecret>,
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
        return DROP_REF
      case "invite":
        return { ...ref, invite: true }
      case "unresolved":
        throw new Error(`${path}: ${resolution.reason}`)
    }
  })
  const decisions = new Map(op.secrets.map((secret) => [secret.path, secret]))
  const withSecrets = replaceSecrets(withRefs, (path) => {
    const provided = secrets.get(path)
    if (provided) {
      if (provided.$secret !== path) throw new Error(`secret ${path}: resolved for a different placeholder`)
      return provided
    }
    const decision = decisions.get(path)
    if (!decision) throw new Error(`secret ${path}: no decision`)
    if (decision.decision === "keep") return { $secret: path, decision: "keep" }
    if (decision.decision === "unset") return { $secret: path, decision: "unset" }
    throw new Error(`secret ${path}: no value was provided`)
  })
  return isPlainObject(withSecrets) ? withSecrets : {}
}

function replaceSecrets(value: unknown, replace: (path: string) => ResolvedConfigSecret): unknown {
  if (isConfigSecret(value)) return replace(value.$secret)
  if (Array.isArray(value)) return value.map((element) => replaceSecrets(element, replace))
  if (isPlainObject(value)) {
    const out: { [key: string]: unknown } = {}
    for (const [key, child] of Object.entries(value)) out[key] = replaceSecrets(child, replace)
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
