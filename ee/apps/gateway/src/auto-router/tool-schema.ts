// Tool parameter schemas reshaped for providers that only take a plain object
// at the root of a tool's input schema.
//
// Clients send whatever JSON Schema their tools declare (MCP servers, app
// connectors and plugins often use a union of argument sets at the root, or
// older drafts). Anthropic, and Claude on Bedrock, reject a tool unless its
// schema has `type: "object"` at the root, no `anyOf` / `oneOf` / `allOf`
// there, and is valid JSON Schema draft 2020-12; one bad tool fails the whole
// request. Gemini drops a root without properties. `objectToolSchema` keeps
// the tool usable instead of dropping it: a root union becomes one object
// with every branch's properties (required only when every branch requires
// them) and the argument sets named in its description, `allOf` is merged,
// local `$ref`s at the root are inlined, and draft-04/07 keywords nested
// anywhere are rewritten to their draft 2020-12 form.
import { isJsonObject, type JsonObject } from "./chat.js"

const MAX_DEPTH = 32
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]
const SCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"]
const SCHEMA_VALUES = ["items", "additionalProperties", "unevaluatedProperties", "contains", "propertyNames", "not", "if", "then", "else"]

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/**
 * A schema rewritten from draft-04/07 forms Anthropic rejects as invalid
 * draft 2020-12: tuple `items` arrays, boolean `exclusiveMinimum` /
 * `exclusiveMaximum`, boolean `required` on a property, and unknown type
 * names.
 */
export function toDraft2020(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.map((item) => toDraft2020(item, depth + 1))
  if (!isJsonObject(value) || depth > MAX_DEPTH) return value
  const out: JsonObject = { ...value }
  // Draft 03 `required: true` on a property → the parent's required list.
  if (isJsonObject(out.properties)) {
    const required = new Set(stringList(out.required))
    const properties: JsonObject = {}
    for (const [name, child] of Object.entries(out.properties)) {
      if (isJsonObject(child) && typeof child.required === "boolean") {
        const { required: flag, ...rest } = child
        if (flag) required.add(name)
        properties[name] = rest
      } else properties[name] = child
    }
    out.properties = properties
    if (required.size) out.required = [...required]
  } else if (typeof out.required === "boolean") delete out.required
  for (const key of SCHEMA_MAPS) {
    const map = out[key]
    if (!isJsonObject(map)) continue
    out[key] = Object.fromEntries(Object.entries(map).map(([name, child]) => [name, toDraft2020(child, depth + 1)]))
  }
  for (const key of SCHEMA_LISTS) {
    if (Array.isArray(out[key])) out[key] = out[key].map((child) => toDraft2020(child, depth + 1))
  }
  for (const key of SCHEMA_VALUES) {
    if (isJsonObject(out[key])) out[key] = toDraft2020(out[key], depth + 1)
  }
  // Draft 2019 and earlier tuples: items: [...] (+ additionalItems) → prefixItems (+ items).
  if (Array.isArray(out.items)) {
    out.prefixItems = out.items.map((child) => toDraft2020(child, depth + 1))
    delete out.items
    if (isJsonObject(out.additionalItems) || typeof out.additionalItems === "boolean") out.items = toDraft2020(out.additionalItems, depth + 1)
    delete out.additionalItems
  }
  // Draft 04 boolean exclusive bounds → numeric ones.
  const bounds: ReadonlyArray<readonly [string, string]> = [["exclusiveMinimum", "minimum"], ["exclusiveMaximum", "maximum"]]
  for (const [exclusive, inclusive] of bounds) {
    if (typeof out[exclusive] !== "boolean") continue
    if (out[exclusive] === true && typeof out[inclusive] === "number") {
      out[exclusive] = out[inclusive]
      delete out[inclusive]
    } else delete out[exclusive]
  }
  if (typeof out.type === "string" && !TYPES.has(out.type)) delete out.type
  else if (Array.isArray(out.type)) {
    const types = out.type.filter((type) => typeof type === "string" && TYPES.has(type))
    if (types.length) out.type = types
    else delete out.type
  }
  return out
}

function resolveLocalRef(ref: string, root: JsonObject): JsonObject | null {
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  if (!match) return null
  const defs = root[match[1] ?? ""]
  const name = (match[2] ?? "").replace(/~1/g, "/").replace(/~0/g, "~")
  const target = isJsonObject(defs) ? defs[name] : undefined
  return isJsonObject(target) ? target : null
}

/** A root-level schema with its own local `$ref` inlined (refs further down stay; `$defs` stays at the root). */
function inlineRootRef(schema: JsonObject, root: JsonObject, seen: Set<string>): JsonObject {
  let current = schema
  while (typeof current.$ref === "string" && !seen.has(current.$ref)) {
    seen.add(current.$ref)
    const target = resolveLocalRef(current.$ref, root)
    if (!target) break
    const { $ref: _ref, ...rest } = current
    current = { ...target, ...rest }
  }
  return current
}

function sameSchema(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Property schemas merged across branches: one schema when they agree, `anyOf` when they differ. */
function mergeProperty(existing: unknown, next: unknown): unknown {
  if (existing === undefined || sameSchema(existing, next)) return next
  const options = isJsonObject(existing) && Array.isArray(existing.anyOf) && Object.keys(existing).length === 1 ? existing.anyOf : [existing]
  return options.some((option) => sameSchema(option, next)) ? existing : { anyOf: [...options, next] }
}

/** The one value a property schema allows (`const`, or a one-value `enum`), following local refs. */
function fixedValue(schema: unknown, root: JsonObject): unknown {
  if (!isJsonObject(schema)) return undefined
  const resolved = inlineRootRef(schema, root, new Set())
  if (resolved.const !== undefined) return resolved.const
  return Array.isArray(resolved.enum) && resolved.enum.length === 1 ? resolved.enum[0] : undefined
}

/**
 * How an argument set is named in the description: its title, else its required arguments (with the
 * value of an argument that has only one, which is usually what tells the sets apart).
 */
function branchLabel(branch: JsonObject, root: JsonObject) {
  if (typeof branch.title === "string" && branch.title.trim()) return branch.title.trim()
  const properties = isJsonObject(branch.properties) ? branch.properties : {}
  const required = stringList(branch.required)
  const names = required.length ? required : Object.keys(properties)
  if (!names.length) return "no arguments"
  return names.map((name) => {
    const value = fixedValue(properties[name], root)
    return value === undefined ? name : `${name}=${JSON.stringify(value)}`
  }).join(", ")
}

function isObjectBranch(branch: JsonObject) {
  const types = typeof branch.type === "string" ? [branch.type] : stringList(branch.type)
  return !types.length || types.includes("object")
}

const COMBINATORS = ["allOf", "anyOf", "oneOf"]

/** The root reduced to one plain object schema; see the file comment. */
function flattenRoot(input: JsonObject, root: JsonObject, depth: number, seen: Set<string>): JsonObject {
  const schema = inlineRootRef(input, root, seen)
  if (depth > MAX_DEPTH) {
    const { allOf: _allOf, anyOf: _anyOf, oneOf: _oneOf, ...rest } = schema
    return rest
  }
  const { allOf, anyOf, oneOf, ...rest } = schema
  const out: JsonObject = { ...rest }
  const properties: JsonObject = isJsonObject(out.properties) ? { ...out.properties } : {}
  const required = new Set(stringList(out.required))
  const branchesOf = (list: unknown) => Array.isArray(list)
    ? list.filter(isJsonObject).map((branch) => inlineRootRef(branch, root, new Set(seen))).filter(isObjectBranch).map((branch) => flattenRoot(branch, root, depth + 1, new Set(seen)))
    : []
  // A union whose branches are unions again (discriminated unions nest them) is one flat list of argument sets.
  const alternativesOf = (list: unknown, level: number): JsonObject[] => {
    if (!Array.isArray(list) || level > MAX_DEPTH) return []
    return list.filter(isJsonObject).map((branch) => inlineRootRef(branch, root, new Set(seen))).filter(isObjectBranch).flatMap((branch) => {
      const { anyOf: nestedAny, oneOf: nestedOne, ...own } = branch
      if (nestedAny === undefined && nestedOne === undefined) return [flattenRoot(branch, root, depth + 1, new Set(seen))]
      return [...alternativesOf(nestedAny, level + 1), ...alternativesOf(nestedOne, level + 1)]
        .map((leaf) => flattenRoot({ ...own, allOf: [leaf] }, root, depth + 1, new Set(seen)))
    })
  }
  const defsOf = (branch: JsonObject) => {
    for (const key of ["$defs", "definitions"]) {
      if (isJsonObject(branch[key])) out[key] = { ...branch[key], ...(isJsonObject(out[key]) ? out[key] : {}) }
    }
  }

  // allOf: every part applies, so properties and required add up.
  for (const part of branchesOf(allOf)) {
    defsOf(part)
    if (isJsonObject(part.properties)) {
      for (const [name, child] of Object.entries(part.properties)) properties[name] = mergeProperty(properties[name], child)
    }
    for (const name of stringList(part.required)) required.add(name)
    for (const [key, child] of Object.entries(part)) {
      if (["properties", "required", "$defs", "definitions", "type", "additionalProperties", "unevaluatedProperties"].includes(key)) continue
      if (out[key] === undefined) out[key] = child
    }
  }

  // anyOf / oneOf: one argument set applies; offer every property and require only what all sets require.
  const alternatives = [...alternativesOf(anyOf, 0), ...alternativesOf(oneOf, 0)]
  if (alternatives.length) {
    const requiredSets = alternatives.map((branch) => new Set(stringList(branch.required)))
    const common = [...(requiredSets[0] ?? [])].filter((name) => requiredSets.every((set) => set.has(name)))
    for (const branch of alternatives) {
      defsOf(branch)
      if (isJsonObject(branch.properties)) {
        for (const [name, child] of Object.entries(branch.properties)) properties[name] = mergeProperty(properties[name], child)
      }
      if (out.additionalProperties === undefined && branch.additionalProperties !== undefined && alternatives.length === 1) out.additionalProperties = branch.additionalProperties
    }
    for (const name of common) required.add(name)
    if (alternatives.length > 1) {
      const sets = alternatives.map((branch, index) => `(${index + 1}) ${branchLabel(branch, root)}`).join("; ")
      const note = `Pass exactly one of these argument sets: ${sets}.`
      out.description = typeof out.description === "string" && out.description.trim() ? `${out.description.trim()}\n\n${note}` : note
    } else {
      const only = alternatives[0]
      if (only && typeof only.description === "string" && out.description === undefined) out.description = only.description
    }
  }

  out.type = "object"
  out.properties = properties
  if (required.size) out.required = [...required]
  else delete out.required
  return out
}

/**
 * A tool's parameter schema as a plain object schema every provider takes: a
 * missing or non-object schema becomes an object without arguments; see the
 * file comment for the rest.
 */
export function objectToolSchema(parameters: unknown): JsonObject {
  if (!isJsonObject(parameters)) return { type: "object", properties: {} }
  const converted = toDraft2020(parameters)
  const schema = isJsonObject(converted) ? converted : parameters
  const hasCombinator = COMBINATORS.some((key) => schema[key] !== undefined)
  if (!hasCombinator && schema.type === "object" && typeof schema.$ref !== "string") return schema
  const types = typeof schema.type === "string" ? [schema.type] : stringList(schema.type)
  if (types.length && !types.includes("object")) {
    // A scalar or array root cannot carry named arguments.
    return { type: "object", properties: {}, ...(typeof schema.description === "string" ? { description: schema.description } : {}) }
  }
  return flattenRoot(schema, schema, 0, new Set())
}
