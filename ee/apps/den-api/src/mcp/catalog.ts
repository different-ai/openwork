import type { Hono } from "hono"
import { z } from "zod"
import { isMcpOperationAllowed, type OpenApiOperation } from "./policy.js"

const METHODS = new Set(["get", "post", "put", "patch", "delete"])

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

      const name = operation.operationId
      if (!name) {
        continue
      }

      if (names.has(name)) {
        throw new Error(`Duplicate MCP tool operationId: ${name}`)
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
