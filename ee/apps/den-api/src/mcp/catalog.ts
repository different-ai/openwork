import type { Hono } from "hono"
import { z } from "zod"
import { isMcpOperationAllowed, type OpenApiOperation } from "./policy.js"

const METHODS = new Set(["get", "post", "put", "patch", "delete"])

// AWS Bedrock's Converse API rejects any `toolConfig.tools.*.member.toolSpec.name`
// longer than 64 characters. MCP clients namespace our tools as
// `<serverName>_<name>` (e.g. `openwork-cloud_` adds 15 chars), so the raw
// operationId budget is even tighter. We keep the registered tool name well
// under 64 so the prefixed name still validates on Bedrock.
export const BEDROCK_MAX_TOOL_NAME_LENGTH = 64
export const MAX_CLIENT_PREFIX = "openwork-cloud_".length // 15
export const MAX_TOOL_NAME_LENGTH = BEDROCK_MAX_TOOL_NAME_LENGTH - MAX_CLIENT_PREFIX // 49

// Generated operationIds are verbose and structured: `<verb>V1<Resource>By<Param>Id<Sub>...`.
// The `V1` version marker and the `By<Param>Id` path-param restatements carry no
// meaning for a model choosing a tool; it reasons about verb + resource nouns.
// Stripping them yields short, unique, human-readable names (e.g.
// `deleteV1ConnectorInstancesByConnectorInstanceIdAccessByGrantId` ->
// `deleteConnectorInstancesAccess`) that an LLM recognizes far more reliably
// than a truncated+hashed name.
function structuralShorten(name: string): string {
  return name
    .replace(/^(get|post|put|patch|delete)V1/, "$1") // version marker is irrelevant to tool selection
    .replace(/By[A-Z][a-zA-Z]*?Id/g, "") // drop "ByConfigObjectId" path-param markers
}

// Deterministic, stable short hash (FNV-1a, base36) used only as a last-resort
// fallback when two structurally-shortened names collide. Stable across runs so
// tool identities don't churn between deploys.
function shortHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

// Produce the registered MCP tool name. Structurally shortens every name for a
// clean, consistent catalog, then disambiguates against `taken` with a short
// deterministic hash suffix only if two operationIds collapse to the same name.
//
// Note: this does NOT silently truncate over-length names. If structural
// shortening cannot fit the budget, buildMcpCatalog's guard throws so the
// regression is fixed in structuralShorten() rather than shipped as a
// hard-to-read hashed name. See the guard in buildMcpCatalog.
export function shortenToolName(operationId: string, taken?: ReadonlySet<string>): string {
  const base = structuralShorten(operationId)
  if (!taken?.has(base)) {
    return base
  }
  // Deterministic disambiguation: append a stable hash of the full operationId.
  const suffix = `_${shortHash(operationId)}`
  let name = `${base.slice(0, Math.max(1, MAX_TOOL_NAME_LENGTH - suffix.length))}${suffix}`
  let salt = 1
  while (taken.has(name)) {
    const salted = `_${shortHash(`${operationId}#${salt}`)}`
    name = `${base.slice(0, Math.max(1, MAX_TOOL_NAME_LENGTH - salted.length))}${salted}`
    salt += 1
  }
  return name
}

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
}

type OpenApiParameter = {
  name?: unknown
  in?: unknown
  required?: unknown
  description?: unknown
  schema?: {
    type?: unknown
    format?: unknown
    enum?: unknown[]
    default?: unknown
  }
}

type OpenApiRequestBody = {
  required?: unknown
  content?: unknown
}

type McpInputSchema = z.ZodObject<Record<string, z.ZodTypeAny>>

export type McpToolOperation = {
  name: string
  method: string
  path: string
  operation: OpenApiOperation
  inputSchema: McpInputSchema
}

function isOpenApiParameter(value: unknown): value is OpenApiParameter {
  return typeof value === "object" && value !== null
}

function getParameters(operation: OpenApiOperation, location: "path" | "query") {
  return (operation.parameters ?? [])
    .filter(isOpenApiParameter)
    .filter((parameter) => parameter.in === location && typeof parameter.name === "string" && parameter.name.length > 0)
}

function schemaForParameter(parameter: OpenApiParameter) {
  const schema = parameter.schema
  const type = schema?.type
  const enumValues = schema?.enum

  let valueSchema: z.ZodTypeAny
  if (Array.isArray(enumValues) && enumValues.length > 0 && enumValues.every((value): value is string => typeof value === "string")) {
    valueSchema = z.enum(enumValues as [string, ...string[]])
  } else if (type === "number" || type === "integer") {
    valueSchema = z.number()
  } else if (type === "boolean") {
    valueSchema = z.boolean()
  } else {
    valueSchema = z.string()
  }

  if (typeof parameter.description === "string" && parameter.description.trim().length > 0) {
    valueSchema = valueSchema.describe(parameter.description)
  }

  return valueSchema
}

function objectForParameters(parameters: OpenApiParameter[], requiredByDefault: boolean) {
  const shape: Record<string, z.ZodTypeAny> = {}

  for (const parameter of parameters) {
    const name = parameter.name as string
    const required = requiredByDefault || parameter.required === true
    const schema = schemaForParameter(parameter)
    shape[name] = required ? schema : schema.optional()
  }

  return z.object(shape).strict()
}

function pathParameterNamesFromTemplate(path: string) {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).filter(Boolean)
}

function buildPathSchema(path: string, operation: OpenApiOperation) {
  const documentedParameters = getParameters(operation, "path")
  const byName = new Map(documentedParameters.map((parameter) => [parameter.name as string, parameter]))
  const parameters = pathParameterNamesFromTemplate(path).map((name) => byName.get(name) ?? { name, in: "path", required: true })

  return parameters.length > 0 ? objectForParameters(parameters, true) : undefined
}

function buildQuerySchema(operation: OpenApiOperation) {
  const parameters = getParameters(operation, "query")
  return parameters.length > 0 ? objectForParameters(parameters, false) : undefined
}

function hasJsonRequestBody(operation: OpenApiOperation) {
  const requestBody = getRequestBody(operation)
  const content = requestBody?.content
  return typeof content === "object" && content !== null && "application/json" in content
}

function getRequestBody(operation: OpenApiOperation): OpenApiRequestBody | null {
  const requestBody = operation.requestBody
  return typeof requestBody === "object" && requestBody !== null ? requestBody : null
}

function buildInputSchema(path: string, operation: OpenApiOperation) {
  const shape: Record<string, z.ZodTypeAny> = {}
  const pathSchema = buildPathSchema(path, operation)
  const querySchema = buildQuerySchema(operation)

  if (pathSchema) {
    shape.path = pathSchema.describe("URL path parameters. Put values for route placeholders here, not in body.")
  }

  if (querySchema) {
    shape.query = querySchema.describe("URL query string parameters.").optional()
  }

  if (hasJsonRequestBody(operation)) {
    const bodySchema = z.unknown().describe("JSON request body fields for this operation.")
    shape.body = getRequestBody(operation)?.required === true ? bodySchema : bodySchema.optional()
  }

  return z.object(shape).strict()
}

function buildInputGuidance(input: McpToolOperation) {
  const sections: string[] = []
  const pathNames = pathParameterNamesFromTemplate(input.path)
  const queryNames = getParameters(input.operation, "query").map((parameter) => parameter.name as string)

  if (pathNames.length > 0) {
    sections.push(`Path parameters: put ${pathNames.map((name) => `\`${name}\``).join(", ")} under \`path\`.`)
  }

  if (queryNames.length > 0) {
    sections.push(`Query parameters: put ${queryNames.map((name) => `\`${name}\``).join(", ")} under \`query\`.`)
  }

  if (hasJsonRequestBody(input.operation)) {
    sections.push("Request body: put JSON body fields under `body` as a JSON object (not a JSON-encoded string). Do not wrap them in `requestBody`.")
  }

  if (sections.length === 0) {
    return null
  }

  return [
    "MCP input shape:",
    ...sections,
    "Do not send OpenAPI wrapper keys like `parameters` or `requestBody`.",
  ].join("\n")
}

export async function loadOpenApiDocument(app: Hono, env: unknown): Promise<OpenApiDocument> {
  const response = await app.fetch(new Request("http://den-api.local/openapi.json"), env)
  if (!response.ok) {
    throw new Error(`Unable to load Den OpenAPI document: ${response.status}`)
  }
  return response.json() as Promise<OpenApiDocument>
}

function buildDescription(input: McpToolOperation) {
  const parts = [
    input.operation.summary,
    input.operation.description,
    `${input.method.toUpperCase()} ${input.path}`,
    buildInputGuidance(input),
  ].filter((part): part is string => typeof part === "string" && part.trim().length > 0)

  return parts.join("\n\n")
}

export function getToolDescription(operation: McpToolOperation) {
  return buildDescription(operation)
}

export function buildMcpCatalog(document: OpenApiDocument): McpToolOperation[] {
  const operations: McpToolOperation[] = []
  const names = new Set<string>()

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!METHODS.has(method.toLowerCase())) {
        continue
      }

      if (!isMcpOperationAllowed({ method, path, operation })) {
        continue
      }

      const operationId = operation.operationId
      if (!operationId) {
        continue
      }

      const name = shortenToolName(operationId, names)
      if (names.has(name)) {
        throw new Error(`Duplicate MCP tool name after shortening: ${name} (operationId: ${operationId})`)
      }

      // Guard against future regressions: a tool name that overflows the client
      // prefix budget (e.g. `openwork-cloud_` + name > 64) is rejected by AWS
      // Bedrock's Converse API and breaks every Bedrock model. Surface it here,
      // at catalog-build time (covered by tests/CI), instead of in production.
      const prefixedLength = MAX_CLIENT_PREFIX + name.length
      if (name.length > MAX_TOOL_NAME_LENGTH) {
        throw new Error(
          `MCP tool name too long for Bedrock: "${name}" (${prefixedLength} chars prefixed, max 64; operationId: ${operationId}). ` +
            `Adjust structuralShorten() in catalog.ts.`,
        )
      }
      names.add(name)

      operations.push({
        name,
        method: method.toUpperCase(),
        path,
        operation,
        inputSchema: buildInputSchema(path, operation),
      })
    }
  }

  return operations.sort((a, b) => a.name.localeCompare(b.name))
}
