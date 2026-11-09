/**
 * `$secret` placeholders (format.md › Secrets). The engine only ever handles
 * decisions; values stay with the caller and are given to `executePlan` as
 * `ResolvedConfigSecret`s. Nothing here puts a value into a plan.
 */
import type {
  ConfigPlanFlag,
  ConfigPlanSecret,
  ConfigSecret,
  ConfigSecretInput,
  ConfigSpec,
} from "@openwork/types/den/config-blobs"
import { isConfigRef, isConfigSecret } from "@openwork/types/den/config-blobs"
import {
  type ArrayLayout,
  arrayElementKey,
  elementSchemaPath,
  isPlainObject,
  joinPath,
} from "./util.js"

export type SecretOccurrence = {
  /** The placeholder's own `$secret` path (what inputs are keyed by). */
  path: string
  /** Where it sits in the spec, with keyed set elements: `credentials.apiKey`, `headers[name=X].value`. */
  field: string
  placeholder: ConfigSecret
}

export function findSecrets(layout: ArrayLayout, spec: unknown): SecretOccurrence[] {
  const out: SecretOccurrence[] = []
  const walk = (value: unknown, field: string, schemaPath: string) => {
    if (isConfigSecret(value)) {
      out.push({ path: value.$secret, field, placeholder: value })
      return
    }
    if (isConfigRef(value)) return
    if (Array.isArray(value)) {
      const childSchema = elementSchemaPath(schemaPath)
      value.forEach((element, index) => {
        const key = arrayElementKey(layout, childSchema, element)
        walk(element, `${field}[${key ? `${key.field}=${key.value}` : index}]`, childSchema)
      })
      return
    }
    if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) walk(child, joinPath(field, key), joinPath(schemaPath, key))
  }
  walk(spec, "", "")
  return out
}

export type SecretDecisionKind = "keep" | "env" | "value" | "unset"

/** One placeholder in an execution op: what to put in its place. Never a value. */
export type ExecutionSecret = { path: string; field: string; decision: SecretDecisionKind; env?: string }

export type PlanSecretsInput = {
  layout: ArrayLayout
  blobSpec: ConfigSpec
  /** The matched target item's current spec, or null for a create. */
  targetSpec: ConfigSpec | null
  /** Inputs from the inputs endpoint, by placeholder path. Values are ignored here. */
  inputs: ReadonlyMap<string, ConfigSecretInput>
  /** Self-hosted operator allowlist for `env` decisions. */
  allowEnv: (name: string) => boolean
  /** False when the op writes nothing (unchanged, untouched, skip): no decision is needed. */
  required: boolean
}

export type PlannedSecrets = {
  secrets: ConfigPlanSecret[]
  execution: ExecutionSecret[]
  flags: ConfigPlanFlag[]
  reasons: string[]
}

export function planSecrets(input: PlanSecretsInput): PlannedSecrets {
  const targetSet = new Map<string, boolean>()
  if (input.targetSpec) for (const occurrence of findSecrets(input.layout, input.targetSpec)) targetSet.set(occurrence.field, occurrence.placeholder.set === true)
  const secrets: ConfigPlanSecret[] = []
  const execution: ExecutionSecret[] = []
  const reasons: string[] = []
  let missing = false
  for (const occurrence of findSecrets(input.layout, input.blobSpec)) {
    const targetHasValue = targetSet.get(occurrence.field) ?? false
    const chosen = decisionFor(occurrence.placeholder, input.inputs.get(occurrence.path))
    const planned: ConfigPlanSecret = {
      path: occurrence.path,
      field: occurrence.field,
      targetHasValue,
      sourceHadValue: occurrence.placeholder.set === true,
      decision: chosen?.decision ?? null,
    }
    if (chosen?.env) planned.env = chosen.env
    secrets.push(planned)
    if (!input.required) continue
    if (!chosen) {
      missing = true
      reasons.push(`${occurrence.field}: choose keep, enter a value, use an environment variable or leave unset`)
      continue
    }
    if (chosen.decision === "keep" && !targetHasValue) {
      missing = true
      reasons.push(`${occurrence.field}: there is no current value to keep`)
      continue
    }
    if (chosen.decision === "env" && !(chosen.env && input.allowEnv(chosen.env))) {
      missing = true
      reasons.push(`${occurrence.field}: environment variable ${chosen.env ?? ""} is not allowed on this server`)
      continue
    }
    execution.push(chosen.env ? { path: occurrence.path, field: occurrence.field, decision: chosen.decision, env: chosen.env } : { path: occurrence.path, field: occurrence.field, decision: chosen.decision })
  }
  return { secrets, execution, flags: missing ? ["needs_input"] : [], reasons }
}

function decisionFor(placeholder: ConfigSecret, input: ConfigSecretInput | undefined): { decision: SecretDecisionKind; env?: string } | null {
  if (input) return input.decision === "env" ? { decision: "env", env: input.env } : { decision: input.decision }
  if (placeholder.keep) return { decision: "keep" }
  if (placeholder.env) return { decision: "env", env: placeholder.env }
  if (placeholder.unset) return { decision: "unset" }
  return null
}
