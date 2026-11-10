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
  comparableTop,
  elementSchemaPath,
  isPlainObject,
  isUnsafeKey,
  joinPath,
} from "./util.js"

/** What a value pasted into a declared secret field is replaced with, everywhere the plan shows it. */
export const REDACTED_SECRET = "[redacted]"

export type SecretOccurrence = {
  /** The placeholder's own `$secret` path (what inputs are keyed by). */
  path: string
  /** Where it sits in the spec, with keyed set elements: `credentials.apiKey`, `headers[name=X].value`. */
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

/**
 * One step of a spec location, kept structured: an object key exactly as it
 * appears in the spec (dots and brackets included), followed by how many
 * array levels were entered under it. Secret matching never re-splits a
 * joined path, so a map key such as `A.B` stays one key.
 */
export type SchemaSegment = { key: string; elements: number }

function enterKey(path: readonly SchemaSegment[], key: string): SchemaSegment[] {
  return [...path, { key, elements: 0 }]
}

function enterElement(path: readonly SchemaSegment[]): SchemaSegment[] {
  const last = path[path.length - 1]
  if (!last) return [{ key: "", elements: 1 }]
  return [...path.slice(0, -1), { key: last.key, elements: last.elements + 1 }]
}

/** A declared pattern (`requestHeaders[].value`, `credentials.apiKeys.*`) as segments. Patterns are written by adapters, never by blob authors. */
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

/** The structured form of a dotted schema path, for callers that only have one (tests, docs). Keys must not contain dots. */
export function schemaSegments(schemaPath: string): SchemaSegment[] {
  return schemaPath === "" ? [] : patternSegments(schemaPath)
}

/**
 * Whether a spec location matches a declared secret field. Array elements are
 * written `[]` in the pattern (`requestHeaders[].value`); a `*` segment
 * matches any one object key whatever characters it holds, for maps keyed by
 * name (`credentials.apiKeys.*` matches the key `OPENAI_API_KEY`, and also
 * the single key `A.B`).
 */
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

/** Characters a key matched by a `*` secret pattern may not hold: they would make its `$secret` path and field ambiguous. */
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
  /** `$secret` placeholders at a location the area does not declare as a secret field. */
  undeclared: string[]
  /** Declared secret locations holding something other than a placeholder (a pasted secret, say). */
  raw: string[]
  /** Keys of a secret map (`credentials.apiKeys.*`) holding `.`, `[` or `]`. */
  invalidKeys: string[]
}

/**
 * Checks a blob spec against the area's `secretFields`: placeholders may only
 * sit at declared fields (wildcard map keys included), and declared fields may
 * only hold placeholders (or nothing). A raw value at a secret field is never
 * accepted inside a blob: values go through the inputs endpoint. Secret map
 * keys may not hold `.`, `[` or `]`.
 */
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

/**
 * A copy of `spec` with every non-placeholder value at a declared secret
 * field replaced by `REDACTED_SECRET`, and the positional paths replaced.
 * Run before anything diffs, hashes or stores the spec, so a secret pasted
 * into a blob never reaches a plan, an error or a log.
 */
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

/**
 * Whether any placeholder in `spec` has an explicit `value` or `env`
 * decision: the item must be written so the new credential is stored, even
 * when nothing else about it changed.
 */
export function replacesSecretValue(layout: ArrayLayout, spec: ConfigSpec, inputs: ReadonlyMap<string, ConfigSecretInput>): boolean {
  return findSecrets(layout, spec).some((occurrence) => {
    const chosen = decisionFor(occurrence.placeholder, inputs.get(occurrence.path))
    return chosen?.decision === "value" || chosen?.decision === "env"
  })
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
