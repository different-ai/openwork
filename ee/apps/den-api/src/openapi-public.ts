import { STATUS_CODES } from "node:http"
import { addOpenApiSocialDescriptions } from "./openapi-social-descriptions.js"

type NormalizationCounts = {
  descriptionsFilled: number
  hideKeysDropped: number
  internalOperationsExcluded: number
  orphanSchemasPruned: number
}

const operationMethods = new Set<string>(["delete", "get", "head", "options", "patch", "post", "put", "trace"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseDescription(status: string) {
  if (status === "default") return "Default response"
  const reason = STATUS_CODES[status]
  return reason ?? `${status} response`
}

function normalizeResponses(responses: unknown, counts: NormalizationCounts) {
  if (!isRecord(responses)) return
  for (const [status, response] of Object.entries(responses)) {
    if (!isRecord(response) || typeof response.$ref === "string") continue
    if (typeof response.description !== "string") {
      response.description = responseDescription(status)
      counts.descriptionsFilled += 1
    }
  }
}

function normalizePathItem(pathItem: Record<string, unknown>, counts: NormalizationCounts) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (operationMethods.has(method.toLowerCase()) && isRecord(operation)) {
      normalizeOperation(operation, counts)
    }
  }
}

function normalizeCallback(callback: Record<string, unknown>, counts: NormalizationCounts) {
  for (const pathItem of Object.values(callback)) {
    if (isRecord(pathItem)) normalizePathItem(pathItem, counts)
  }
}

function normalizeOperation(operation: Record<string, unknown>, counts: NormalizationCounts) {
  if (Object.hasOwn(operation, "hide")) {
    delete operation.hide
    counts.hideKeysDropped += 1
  }

  normalizeResponses(operation.responses, counts)

  const callbacks = operation.callbacks
  if (!isRecord(callbacks)) return
  for (const callback of Object.values(callbacks)) {
    if (isRecord(callback)) normalizeCallback(callback, counts)
  }
}

function normalizePathItems(pathItems: unknown, counts: NormalizationCounts) {
  if (!isRecord(pathItems)) return
  for (const pathItem of Object.values(pathItems)) {
    if (isRecord(pathItem)) normalizePathItem(pathItem, counts)
  }
}

// Operations tagged Internal (Automation runner protocol, development-only
// email outbox) stay in the served /openapi.json for debugging but are not part
// of the published contract.
const excludedTags = new Set<string>(["Internal"])

function hasExcludedTag(operation: Record<string, unknown>) {
  return Array.isArray(operation.tags) && operation.tags.some((tag) => typeof tag === "string" && excludedTags.has(tag))
}

function excludeInternalOperations(document: Record<string, unknown>, counts: NormalizationCounts) {
  const paths = document.paths
  if (!isRecord(paths)) return
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operationMethods.has(method.toLowerCase()) && isRecord(operation) && hasExcludedTag(operation)) {
        delete pathItem[method]
        counts.internalOperationsExcluded += 1
      }
    }
    if (Object.keys(pathItem).every((key) => !operationMethods.has(key.toLowerCase()))) {
      delete paths[path]
    }
  }
  if (Array.isArray(document.tags)) {
    document.tags = document.tags.filter((tag) => !(isRecord(tag) && typeof tag.name === "string" && excludedTags.has(tag.name)))
  }
}

const schemaRefPrefix = "#/components/schemas/"

function collectSchemaRefs(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, into)
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith(schemaRefPrefix)) {
      into.add(child.slice(schemaRefPrefix.length))
    } else {
      collectSchemaRefs(child, into)
    }
  }
}

// Schemas registered through Zod `.meta({ id })` land in components.schemas
// even when every route that references them is `hide: true` or was excluded
// above (Internal tags, /openapi.json describing itself). Keep only schemas
// reachable from the remaining document, following $ref transitively, so the
// published contract does not advertise types no documented operation uses.
function pruneOrphanSchemas(document: Record<string, unknown>, counts: NormalizationCounts) {
  const components = document.components
  if (!isRecord(components)) return
  const schemas = components.schemas
  if (!isRecord(schemas)) return

  const reachable = new Set<string>()
  const pending = new Set<string>()
  for (const [key, value] of Object.entries(document)) {
    if (key === "components") {
      for (const [componentKind, component] of Object.entries(components)) {
        if (componentKind !== "schemas") collectSchemaRefs(component, pending)
      }
    } else {
      collectSchemaRefs(value, pending)
    }
  }
  while (pending.size > 0) {
    const [name] = pending
    pending.delete(name)
    if (reachable.has(name)) continue
    reachable.add(name)
    const next = new Set<string>()
    collectSchemaRefs(schemas[name], next)
    for (const ref of next) {
      if (!reachable.has(ref)) pending.add(ref)
    }
  }

  for (const name of Object.keys(schemas)) {
    if (!reachable.has(name)) {
      delete schemas[name]
      counts.orphanSchemasPruned += 1
    }
  }
}

function normalizeOpenApiDocument(document: Record<string, unknown>) {
  const counts: NormalizationCounts = {
    descriptionsFilled: 0,
    hideKeysDropped: 0,
    internalOperationsExcluded: 0,
    orphanSchemasPruned: 0,
  }
  excludeInternalOperations(document, counts)
  pruneOrphanSchemas(document, counts)
  normalizePathItems(document.paths, counts)
  normalizePathItems(document.webhooks, counts)
  return counts
}

/** A detached, normalized contract; never mutate the raw document cached by Den. */
export function publicOpenApiDocument(original: unknown) {
  if (!isRecord(original)) throw new Error("OpenAPI response was not a JSON object.")
  // Hono metadata can contain functions. Match the raw endpoint's JSON wire
  // representation before normalizing, while preserving its cached object.
  const document: unknown = JSON.parse(JSON.stringify(original))
  if (!isRecord(document)) throw new Error("OpenAPI response was not a JSON object.")
  const counts = normalizeOpenApiDocument(document)
  const social = addOpenApiSocialDescriptions(document)
  return { document: social.document, counts: { ...counts, ...social.counts } }
}
