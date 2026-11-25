import type { ConfigArea, ConfigAreaContext, ConfigPreflightResult } from "../area.js"
import { preflightKey, previewOp, type ExecutionPlan } from "./plan.js"

export async function runPreflight(execution: ExecutionPlan, areas: readonly ConfigArea[], ctx: ConfigAreaContext): Promise<Map<string, ConfigPreflightResult>> {
  const byKey = new Map(areas.map((area) => [area.key, area]))
  const out = new Map<string, ConfigPreflightResult>()
  for (const op of execution.ops) {
    const area = byKey.get(op.area)
    if (!area?.preflight) continue
    const preview = previewOp(op)
    if (!preview) continue
    let verdict: ConfigPreflightResult | null
    try {
      verdict = await area.preflight(ctx, preview, {
        secrets: op.secrets.map((secret) => ({ path: secret.path, field: secret.field, decision: secret.decision })),
        refs: op.refs.map((ref) => ({ path: ref.path, ref: ref.ref, resolution: ref.resolution.kind, ...(ref.resolution.kind === "target" ? { id: ref.resolution.id } : {}) })),
      })
    } catch {
      verdict = { warnings: ["this change couldn't be checked before apply"] }
    }
    if (verdict && (verdict.skip || verdict.block || (verdict.warnings?.length ?? 0) > 0)) out.set(preflightKey(op.area, op.ref), verdict)
  }
  return out
}
