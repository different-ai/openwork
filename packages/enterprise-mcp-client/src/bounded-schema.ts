import { Buffer } from "node:buffer"
import { EnterpriseMcpCatalogError } from "./errors.js"

export const ENTERPRISE_MCP_TOOL_SCHEMA_LIMIT_BYTES = 512 * 1024
export const ENTERPRISE_MCP_TOOL_SCHEMA_DEPTH_LIMIT = 64
export const ENTERPRISE_MCP_TOOL_SCHEMA_NODE_LIMIT = 20_000
export const ENTERPRISE_MCP_TOOL_SCHEMA_COMPOSITION_BRANCH_LIMIT = 256
export const ENTERPRISE_MCP_TOOL_SCHEMA_REFERENCE_DEPTH_LIMIT = 32
const MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

export type EnterpriseMcpHeaderParameterBinding = {
  parameterPath: string[]
  headerName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodePointerSegment(value: string): string {
  try {
    return decodeURIComponent(value).replaceAll("~1", "/").replaceAll("~0", "~")
  } catch {
    throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_UNRESOLVED")
  }
}

function resolvePointer(root: unknown, reference: string, anchors: Map<string, unknown>): unknown {
  if (reference === "#") return root
  if (reference.startsWith("#") && !reference.startsWith("#/")) {
    const anchored = anchors.get(reference.slice(1))
    if (anchored !== undefined) return anchored
    throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_UNRESOLVED")
  }
  if (!reference.startsWith("#/")) {
    throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_EXTERNAL_REFERENCE")
  }
  let current = root
  for (const rawSegment of reference.slice(2).split("/")) {
    const segment = decodePointerSegment(rawSegment)
    if (Array.isArray(current)) {
      const index = Number(segment)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_UNRESOLVED")
      }
      current = current[index]
      continue
    }
    if (!isRecord(current) || !(segment in current)) {
      throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_UNRESOLVED")
    }
    current = current[segment]
  }
  return current
}

function collectSchemaMeasurements(root: unknown): {
  anchors: Map<string, unknown>
  references: string[]
} {
  type Frame = { value: unknown; depth: number; leaving?: object }
  const stack: Frame[] = [{ value: root, depth: 0 }]
  const active = new WeakSet<object>()
  const anchors = new Map<string, unknown>()
  const references: string[] = []
  let nodes = 0
  let compositionBranches = 0
  while (stack.length > 0) {
    const frame = stack.pop()
    if (!frame) break
    if (frame.leaving) {
      active.delete(frame.leaving)
      continue
    }
    nodes += 1
    if (nodes > ENTERPRISE_MCP_TOOL_SCHEMA_NODE_LIMIT) {
      throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_NODE_LIMIT")
    }
    if (frame.depth > ENTERPRISE_MCP_TOOL_SCHEMA_DEPTH_LIMIT) {
      throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_DEPTH_LIMIT")
    }
    if (typeof frame.value !== "object" || frame.value === null) continue
    if (active.has(frame.value)) throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_CYCLE")
    active.add(frame.value)
    stack.push({ value: null, depth: frame.depth, leaving: frame.value })
    if (isRecord(frame.value)) {
      if (typeof frame.value.$anchor === "string" && frame.value.$anchor) {
        if (anchors.has(frame.value.$anchor)) {
          throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_UNRESOLVED")
        }
        anchors.set(frame.value.$anchor, frame.value)
      }
      if (typeof frame.value.$ref === "string") references.push(frame.value.$ref)
      for (const keyword of ["oneOf", "anyOf", "allOf"]) {
        const branches = frame.value[keyword]
        if (Array.isArray(branches)) compositionBranches += branches.length
      }
      if (compositionBranches > ENTERPRISE_MCP_TOOL_SCHEMA_COMPOSITION_BRANCH_LIMIT) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_COMPOSITION_LIMIT")
      }
    }
    const children = Array.isArray(frame.value) ? frame.value : Object.values(frame.value)
    for (const child of children) stack.push({ value: child, depth: frame.depth + 1 })
  }
  return { anchors, references }
}

function assertReferenceTree(input: {
  root: unknown
  value: unknown
  anchors: Map<string, unknown>
  activeTargets: WeakSet<object>
  completeTargets: WeakSet<object>
  depth: number
}): void {
  if (input.depth > ENTERPRISE_MCP_TOOL_SCHEMA_REFERENCE_DEPTH_LIMIT) {
    throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_DEPTH_LIMIT")
  }
  if (typeof input.value !== "object" || input.value === null) return
  if (input.completeTargets.has(input.value)) return
  if (isRecord(input.value) && typeof input.value.$ref === "string") {
    const target = resolvePointer(input.root, input.value.$ref, input.anchors)
    if (typeof target === "object" && target !== null) {
      if (input.activeTargets.has(target)) {
        throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_REFERENCE_CYCLE")
      }
      input.activeTargets.add(target)
      assertReferenceTree({ ...input, value: target, depth: input.depth + 1 })
      input.activeTargets.delete(target)
      input.completeTargets.add(target)
    }
  }
  const children = Array.isArray(input.value) ? input.value : Object.values(input.value)
  for (const child of children) {
    assertReferenceTree({ ...input, value: child, depth: input.depth })
  }
  input.completeTargets.add(input.value)
}

export function assertEnterpriseMcpSchema(schema: unknown): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(schema)
  } catch {
    throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_CYCLE")
  }
  if (
    serialized !== undefined
    && Buffer.byteLength(serialized, "utf8") > ENTERPRISE_MCP_TOOL_SCHEMA_LIMIT_BYTES
  ) {
    throw new EnterpriseMcpCatalogError("MCP_CATALOG_SCHEMA_SIZE_LIMIT")
  }
  const { anchors, references } = collectSchemaMeasurements(schema)
  for (const reference of references) {
    const target = resolvePointer(schema, reference, anchors)
    const activeTargets = new WeakSet<object>()
    if (typeof target === "object" && target !== null) activeTargets.add(target)
    assertReferenceTree({
      root: schema,
      value: target,
      anchors,
      activeTargets,
      completeTargets: new WeakSet<object>(),
      depth: 0,
    })
  }
}

function routingHeaderError(): never {
  throw new EnterpriseMcpCatalogError("MCP_CATALOG_TOOL_ROUTING_HEADER_INVALID")
}

function collectMcpHeaderBindings(input: {
  root: unknown
  value: unknown
  path: string[]
  anchors: Map<string, unknown>
  activeReferences: WeakSet<object>
  bindings: EnterpriseMcpHeaderParameterBinding[]
  headerNames: Set<string>
  referenceDepth: number
}): void {
  if (!isRecord(input.value)) return

  if (Object.hasOwn(input.value, "x-mcp-header")) {
    const headerName = input.value["x-mcp-header"]
    if (
      typeof headerName !== "string"
      || !MCP_HEADER_NAME_PATTERN.test(headerName)
      || !["string", "integer", "boolean"].includes(String(input.value.type))
      || input.path.length === 0
    ) {
      routingHeaderError()
    }
    const folded = headerName.toLowerCase()
    if (input.headerNames.has(folded)) routingHeaderError()
    input.headerNames.add(folded)
    input.bindings.push({ parameterPath: [...input.path], headerName })
  }

  if (typeof input.value.$ref === "string") {
    if (input.referenceDepth >= ENTERPRISE_MCP_TOOL_SCHEMA_REFERENCE_DEPTH_LIMIT) {
      routingHeaderError()
    }
    const target = resolvePointer(input.root, input.value.$ref, input.anchors)
    if (typeof target === "object" && target !== null) {
      if (input.activeReferences.has(target)) routingHeaderError()
      input.activeReferences.add(target)
      collectMcpHeaderBindings({
        ...input,
        value: target,
        activeReferences: input.activeReferences,
        referenceDepth: input.referenceDepth + 1,
      })
      input.activeReferences.delete(target)
    }
  }

  if (isRecord(input.value.properties)) {
    for (const [property, schema] of Object.entries(input.value.properties)) {
      collectMcpHeaderBindings({
        ...input,
        value: schema,
        path: [...input.path, property],
      })
    }
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = input.value[keyword]
    if (!Array.isArray(branches)) continue
    for (const branch of branches) {
      collectMcpHeaderBindings({ ...input, value: branch })
    }
  }
  for (const keyword of ["if", "then", "else", "not"] as const) {
    if (input.value[keyword] !== undefined) {
      collectMcpHeaderBindings({ ...input, value: input.value[keyword] })
    }
  }
  if (isRecord(input.value.dependentSchemas)) {
    for (const schema of Object.values(input.value.dependentSchemas)) {
      collectMcpHeaderBindings({ ...input, value: schema })
    }
  }
}

/**
 * Returns the static property paths that the current Streamable HTTP
 * transport must mirror into Mcp-Param-* headers. A single invalid annotation
 * rejects this tool definition, allowing the catalog collector to omit it
 * without discarding unrelated healthy tools.
 */
export function extractEnterpriseMcpHeaderParameterBindings(
  schema: unknown,
): EnterpriseMcpHeaderParameterBinding[] {
  assertEnterpriseMcpSchema(schema)
  const { anchors } = collectSchemaMeasurements(schema)
  const bindings: EnterpriseMcpHeaderParameterBinding[] = []
  collectMcpHeaderBindings({
    root: schema,
    value: schema,
    path: [],
    anchors,
    activeReferences: new WeakSet<object>(),
    bindings,
    headerNames: new Set<string>(),
    referenceDepth: 0,
  })
  return bindings
}
