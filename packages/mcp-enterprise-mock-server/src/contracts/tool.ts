import { z } from "zod"

export interface ToolSchemaBase {
  readonly description?: string
}

export type ToolSchemaNode =
  | (ToolSchemaBase & {
      readonly type: "string"
      readonly enum?: readonly string[]
      readonly minLength?: number
      readonly maxLength?: number
    })
  | (ToolSchemaBase & {
      readonly type: "number" | "integer"
      readonly minimum?: number
      readonly maximum?: number
    })
  | (ToolSchemaBase & { readonly type: "boolean" | "null" })
  | (ToolSchemaBase & {
      readonly type: "array"
      readonly items: ToolSchemaNode
      readonly minItems?: number
      readonly maxItems?: number
    })
  | (ToolSchemaBase & {
      readonly type: "object"
      readonly properties: Readonly<Record<string, ToolSchemaNode>>
      readonly required: readonly string[]
      readonly additionalProperties: boolean | ToolSchemaNode
    })
  | (ToolSchemaBase & { readonly oneOf: readonly ToolSchemaNode[] })
  | (ToolSchemaBase & { readonly anyOf: readonly ToolSchemaNode[] })

export type ToolProperty = ToolSchemaNode
export type ToolInputSchema = Extract<ToolSchemaNode, { readonly type: "object" }>

const maximumSchemaDepth = 10
const maximumSchemaNodes = 512
const maximumSchemaBytes = 64 * 1024
const maximumProperties = 128
const maximumCompositionBranches = 8
const maximumDescriptionLength = 2_000
const maximumArgumentDepth = 20
const maximumArgumentNodes = 20_000
const maximumArgumentIssues = 25

const commonKeys = new Set(["description"])
const keysByType: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set(["type", "description", "enum", "minLength", "maxLength"]),
  number: new Set(["type", "description", "minimum", "maximum"]),
  integer: new Set(["type", "description", "minimum", "maximum"]),
  boolean: new Set(["type", "description"]),
  null: new Set(["type", "description"]),
  array: new Set(["type", "description", "items", "minItems", "maxItems"]),
  object: new Set(["type", "description", "properties", "required", "additionalProperties"]),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function pushUnknownKeyIssues(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${path} uses unsupported JSON Schema keyword '${key}'`)
  }
}

function schemaDefinitionIssues(value: unknown): string[] {
  const issues: string[] = []
  let remainingNodes = maximumSchemaNodes
  const ancestors = new Set<object>()

  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumSchemaBytes) {
      issues.push(`Tool schema exceeds ${maximumSchemaBytes} bytes`)
      return issues
    }
  } catch {
    issues.push("Tool schema must be acyclic JSON data")
    return issues
  }

  const visit = (node: unknown, depth: number, path: string): void => {
    if (issues.length >= maximumArgumentIssues) return
    if (!isRecord(node)) {
      issues.push(`${path} must be a JSON Schema object`)
      return
    }
    if (depth > maximumSchemaDepth) {
      issues.push(`${path} exceeds maximum schema depth ${maximumSchemaDepth}`)
      return
    }
    remainingNodes -= 1
    if (remainingNodes < 0) {
      issues.push(`Tool schema exceeds ${maximumSchemaNodes} nodes`)
      return
    }
    if (ancestors.has(node)) {
      issues.push(`${path} contains a cycle`)
      return
    }
    ancestors.add(node)

    if (node.description !== undefined && (typeof node.description !== "string" || node.description.length === 0 || node.description.length > maximumDescriptionLength)) {
      issues.push(`${path}.description must contain 1-${maximumDescriptionLength} characters`)
    }

    const compositionKey = "oneOf" in node ? "oneOf" : "anyOf" in node ? "anyOf" : null
    if (compositionKey) {
      pushUnknownKeyIssues(node, new Set([...commonKeys, compositionKey]), path, issues)
      const branches = node[compositionKey]
      if (!Array.isArray(branches) || branches.length < 1 || branches.length > maximumCompositionBranches) {
        issues.push(`${path}.${compositionKey} must contain 1-${maximumCompositionBranches} schemas`)
      } else {
        branches.forEach((branch, index) => visit(branch, depth + 1, `${path}.${compositionKey}[${index}]`))
      }
      ancestors.delete(node)
      return
    }

    const type = node.type
    if (typeof type !== "string" || !Object.hasOwn(keysByType, type)) {
      issues.push(`${path}.type must be one supported JSON Schema type`)
      ancestors.delete(node)
      return
    }
    pushUnknownKeyIssues(node, keysByType[type] ?? commonKeys, path, issues)

    if (type === "string") {
      if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length < 1 || node.enum.length > 100 || node.enum.some((item) => typeof item !== "string"))) {
        issues.push(`${path}.enum must contain 1-100 strings`)
      }
      if (node.minLength !== undefined && !integerInRange(node.minLength, 0, 1_048_576)) issues.push(`${path}.minLength is invalid`)
      if (node.maxLength !== undefined && !integerInRange(node.maxLength, 1, 1_048_576)) issues.push(`${path}.maxLength is invalid`)
      if (finiteNumber(node.minLength) && finiteNumber(node.maxLength) && node.minLength > node.maxLength) issues.push(`${path} has minLength greater than maxLength`)
    } else if (type === "number" || type === "integer") {
      if (node.minimum !== undefined && !finiteNumber(node.minimum)) issues.push(`${path}.minimum must be finite`)
      if (node.maximum !== undefined && !finiteNumber(node.maximum)) issues.push(`${path}.maximum must be finite`)
      if (finiteNumber(node.minimum) && finiteNumber(node.maximum) && node.minimum > node.maximum) issues.push(`${path} has minimum greater than maximum`)
    } else if (type === "array") {
      if (!("items" in node)) issues.push(`${path}.items is required`)
      else visit(node.items, depth + 1, `${path}.items`)
      if (node.minItems !== undefined && !integerInRange(node.minItems, 0, 10_000)) issues.push(`${path}.minItems is invalid`)
      if (node.maxItems !== undefined && !integerInRange(node.maxItems, 1, 10_000)) issues.push(`${path}.maxItems is invalid`)
      if (finiteNumber(node.minItems) && finiteNumber(node.maxItems) && node.minItems > node.maxItems) issues.push(`${path} has minItems greater than maxItems`)
    } else if (type === "object") {
      if (!isRecord(node.properties) || Object.keys(node.properties).length > maximumProperties) {
        issues.push(`${path}.properties must be an object with at most ${maximumProperties} entries`)
      } else {
        for (const [name, property] of Object.entries(node.properties)) {
          if (!name || name.length > 128) issues.push(`${path}.properties contains an invalid property name`)
          visit(property, depth + 1, `${path}.properties.${name}`)
        }
      }
      if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== "string" || !name)) {
        issues.push(`${path}.required must be an array of property names`)
      } else {
        const unique = new Set(node.required)
        if (unique.size !== node.required.length) issues.push(`${path}.required contains duplicates`)
        for (const name of unique) {
          if (!isRecord(node.properties) || !Object.hasOwn(node.properties, name)) issues.push(`${path}.required references undeclared property '${name}'`)
        }
      }
      if (typeof node.additionalProperties !== "boolean") {
        if (!("additionalProperties" in node)) issues.push(`${path}.additionalProperties is required`)
        else visit(node.additionalProperties, depth + 1, `${path}.additionalProperties`)
      }
    }
    ancestors.delete(node)
  }

  visit(value, 0, "$schema")
  return issues
}

function schemaContract<Output extends ToolSchemaNode>(rootMustBeObject: boolean): z.ZodType<Output> {
  return z
    .unknown()
    .superRefine((value, context) => {
      for (const message of schemaDefinitionIssues(value)) context.addIssue({ code: "custom", message })
      if (rootMustBeObject && (!isRecord(value) || value.type !== "object")) {
        context.addIssue({ code: "custom", message: "A tool input schema root must have type 'object'" })
      }
    })
    .transform((value) => value as Output)
}

export const toolPropertySchema = schemaContract<ToolSchemaNode>(false)
export const toolInputSchemaSchema = schemaContract<ToolInputSchema>(true)

export const mockToolSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  kind: z.enum(["read", "mutation"]),
  inputSchema: toolInputSchemaSchema,
})

export type MockTool = z.infer<typeof mockToolSchema>

export type ArgumentValidationResult =
  | { readonly success: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly success: false; readonly issues: readonly string[] }

interface ArgumentContext {
  remainingNodes: number
  readonly issues: string[]
}

function validateNode(schema: ToolSchemaNode, value: unknown, path: string, depth: number, context: ArgumentContext): void {
  if (context.issues.length >= maximumArgumentIssues) return
  context.remainingNodes -= 1
  if (context.remainingNodes < 0) {
    context.issues.push(`Arguments exceed ${maximumArgumentNodes} values`)
    return
  }
  if (depth > maximumArgumentDepth) {
    context.issues.push(`${path} exceeds maximum argument depth ${maximumArgumentDepth}`)
    return
  }

  if ("oneOf" in schema || "anyOf" in schema) {
    const branches = "oneOf" in schema ? schema.oneOf : schema.anyOf
    const validBranches = branches.filter((branch) => {
      const branchContext: ArgumentContext = { remainingNodes: context.remainingNodes, issues: [] }
      validateNode(branch, value, path, depth + 1, branchContext)
      return branchContext.issues.length === 0
    }).length
    const valid = "oneOf" in schema ? validBranches === 1 : validBranches >= 1
    if (!valid) context.issues.push(`${path} does not match the declared schema alternatives`)
    return
  }

  if (schema.type === "string") {
    if (typeof value !== "string") context.issues.push(`${path} must be a string`)
    else if (schema.enum && !schema.enum.includes(value)) context.issues.push(`${path} must be one of ${schema.enum.join(", ")}`)
    else if (schema.minLength !== undefined && value.length < schema.minLength) context.issues.push(`${path} is shorter than ${schema.minLength}`)
    else if (schema.maxLength !== undefined && value.length > schema.maxLength) context.issues.push(`${path} is longer than ${schema.maxLength}`)
    return
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) context.issues.push(`${path} must be a finite number`)
    else if (schema.type === "integer" && !Number.isInteger(value)) context.issues.push(`${path} must be an integer`)
    else if (schema.minimum !== undefined && value < schema.minimum) context.issues.push(`${path} must be at least ${schema.minimum}`)
    else if (schema.maximum !== undefined && value > schema.maximum) context.issues.push(`${path} must be at most ${schema.maximum}`)
    return
  }
  if (schema.type === "boolean") {
    if (typeof value !== "boolean") context.issues.push(`${path} must be a boolean`)
    return
  }
  if (schema.type === "null") {
    if (value !== null) context.issues.push(`${path} must be null`)
    return
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      context.issues.push(`${path} must be an array`)
      return
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) context.issues.push(`${path} requires at least ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) context.issues.push(`${path} accepts at most ${schema.maxItems} items`)
    value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`, depth + 1, context))
    return
  }

  if (schema.type !== "object") {
    context.issues.push(`${path} uses an unsupported schema branch`)
    return
  }

  if (!isRecord(value)) {
    context.issues.push(`${path} must be an object`)
    return
  }
  for (const requiredName of schema.required) {
    if (!Object.hasOwn(value, requiredName)) context.issues.push(`${path} is missing required property '${requiredName}'`)
  }
  for (const [name, propertyValue] of Object.entries(value)) {
    const property = Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined
    if (property) validateNode(property, propertyValue, `${path}.${name}`, depth + 1, context)
    else if (schema.additionalProperties === false) context.issues.push(`${path} contains unknown property '${name}'`)
    else if (schema.additionalProperties !== true) validateNode(schema.additionalProperties, propertyValue, `${path}.${name}`, depth + 1, context)
  }
}

export function validateToolArguments(schema: ToolInputSchema, value: unknown): ArgumentValidationResult {
  if (!isRecord(value)) return { success: false, issues: ["Arguments must be an object"] }
  const context: ArgumentContext = { remainingNodes: maximumArgumentNodes, issues: [] }
  validateNode(schema, value, "$arguments", 0, context)
  return context.issues.length === 0 ? { success: true, value } : { success: false, issues: context.issues }
}
