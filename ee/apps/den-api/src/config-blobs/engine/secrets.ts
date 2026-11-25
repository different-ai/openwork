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
  comparableTop,
  elementSchemaPath,
  isPlainObject,
  isUnsafeKey,
  joinPath,
} from "./util.js"

export const REDACTED_SECRET = "[redacted]"

export type SecretOccurrence = {
  path: string
  field: string
  placeholder: ConfigSecret
}

export function findSecrets(layout: ArrayLayout, spec: unknown): SecretOccurrence[] {
  const top = comparableTop(layout, spec)
  layout = top.layout
  spec = top.value
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

export type SchemaSegment = { key: string; elements: number }

function enterKey(path: readonly SchemaSegment[], key: string): SchemaSegment[] {
  return [...path, { key, elements: 0 }]
}

function enterElement(path: readonly SchemaSegment[]): SchemaSegment[] {
  const last = path[path.length - 1]
  if (!last) return [{ key: "", elements: 1 }]
  return [...path.slice(0, -1), { key: last.key, elements: last.elements + 1 }]
}

function patternSegments(pattern: string): SchemaSegment[] {
  return pattern.split(".").map((part) => {
    let key = part
    let elements = 0
    while (key.endsWith("[]")) {
      key = key.slice(0, -2)
      elements += 1
    }
    return { key, elements }
  })
}

export function schemaSegments(schemaPath: string): SchemaSegment[] {
  return schemaPath === "" ? [] : patternSegments(schemaPath)
}

export function matchesSecretField(pattern: string, path: readonly SchemaSegment[] | string): boolean {
  const want = patternSegments(pattern)
  const have = typeof path === "string" ? schemaSegments(path) : path
  if (want.length !== have.length) return false
  return want.every((segment, index) => {
    const actual = have[index]
    if (!actual || segment.elements !== actual.elements) return false
    return segment.key === "*" || segment.key === actual.key
  })
}

const AMBIGUOUS_MAP_KEY = /[.[\]]/

function wildcardKeyProblem(secretFields: readonly string[], path: readonly SchemaSegment[]): boolean {
  const last = path[path.length - 1]
  if (!last || !AMBIGUOUS_MAP_KEY.test(last.key)) return false
  return secretFields.some((pattern) => {
    const want = patternSegments(pattern)
    const segment = want[path.length - 1]
    return segment?.key === "*" && matchesSecretField(pattern, path)
  })
}

export type SecretFieldProblems = {
  undeclared: string[]
  raw: string[]
  invalidKeys: string[]
}

export function checkSecretFields(secretFields: readonly string[], spec: unknown): SecretFieldProblems {
  const problems: SecretFieldProblems = { undeclared: [], raw: [], invalidKeys: [] }
  const declared = (path: readonly SchemaSegment[]) => secretFields.some((pattern) => matchesSecretField(pattern, path))
  const walk = (value: unknown, field: string, path: readonly SchemaSegment[]) => {
    if (value === undefined || value === null) return
    const isSecretField = path.length > 0 && declared(path)
    if (isSecretField && wildcardKeyProblem(secretFields, path)) problems.invalidKeys.push(field)
    if (isConfigSecret(value)) {
      if (!isSecretField) problems.undeclared.push(field || "(spec)")
      return
    }
    if (isSecretField) {
      problems.raw.push(field)
      return
    }
    if (isConfigRef(value)) return
    if (Array.isArray(value)) {
      const childPath = enterElement(path)
      value.forEach((element, index) => walk(element, `${field}[${index}]`, childPath))
      return
    }
    if (isPlainObject(value)) for (const [key, child] of Object.entries(value)) walk(child, joinPath(field, key), enterKey(path, key))
  }
  walk(spec, "", [])
  return problems
}

export function redactRawSecrets(secretFields: readonly string[], spec: ConfigSpec): { spec: ConfigSpec; redacted: string[] } {
  if (secretFields.length === 0) return { spec, redacted: [] }
  const redacted: string[] = []
  const declared = (path: readonly SchemaSegment[]) => secretFields.some((pattern) => matchesSecretField(pattern, path))
  const walk = (value: unknown, field: string, path: readonly SchemaSegment[]): unknown => {
    if (value === undefined || value === null) return value
    if (isConfigSecret(value)) return value
    if (path.length > 0 && declared(path)) {
      redacted.push(field)
      return REDACTED_SECRET
    }
    if (isConfigRef(value)) return value
    if (Array.isArray(value)) {
      const childPath = enterElement(path)
      return value.map((element, index) => walk(element, `${field}[${index}]`, childPath))
    }
    if (isPlainObject(value)) {
      const out: { [key: string]: unknown } = {}
      for (const [key, child] of Object.entries(value)) {
        if (isUnsafeKey(key)) continue
        out[key] = walk(child, joinPath(field, key), enterKey(path, key))
      }
      return out
    }
    return value
  }
  const out = walk(spec, "", [])
  if (redacted.length === 0) return { spec, redacted }
  return { spec: isPlainObject(out) ? out : {}, redacted }
}

export function replacesSecretValue(layout: ArrayLayout, spec: ConfigSpec, inputs: ReadonlyMap<string, ConfigSecretInput>): boolean {
  return findSecrets(layout, spec).some((occurrence) => {
    const chosen = decisionFor(occurrence.placeholder, inputs.get(occurrence.path), false)
    return chosen?.decision === "value" || chosen?.decision === "env"
  })
}

export type SecretDecisionKind = "keep" | "env" | "value" | "unset"

export type ExecutionSecret = { path: string; field: string; decision: SecretDecisionKind; env?: string }

export type PlanSecretsInput = {
  layout: ArrayLayout
  blobSpec: ConfigSpec
  targetSpec: ConfigSpec | null
  inputs: ReadonlyMap<string, ConfigSecretInput>
  allowEnv: (name: string) => boolean
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
    const chosen = decisionFor(occurrence.placeholder, input.inputs.get(occurrence.path), targetHasValue)
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

function decisionFor(placeholder: ConfigSecret, input: ConfigSecretInput | undefined, targetHasValue: boolean): { decision: SecretDecisionKind; env?: string } | null {
  if (input) return input.decision === "env" ? { decision: "env", env: input.env } : { decision: input.decision }
  if (placeholder.keep) return { decision: "keep" }
  if (placeholder.env) return { decision: "env", env: placeholder.env }
  if (placeholder.unset) return { decision: "unset" }
  if (placeholder.set === false) return { decision: targetHasValue ? "keep" : "unset" }
  return null
}
