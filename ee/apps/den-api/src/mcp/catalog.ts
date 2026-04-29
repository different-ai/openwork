import type { Hono } from "hono"
import { z } from "zod"
import { isMcpOperationAllowed, type OpenApiOperation } from "./policy.js"

const METHODS = new Set(["get", "post", "put", "patch", "delete"])

type OpenApiDocument = {
  paths?: Record<string, Record<string, OpenApiOperation>>
}

export type McpToolOperation = {
  name: string
  method: string
  path: string
  operation: OpenApiOperation
  inputSchema: z.ZodObject<{
    path: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
    query: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
    body: z.ZodOptional<z.ZodUnknown>
  }>
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
        inputSchema: z.object({
          path: z.record(z.string(), z.unknown()).optional(),
          query: z.record(z.string(), z.unknown()).optional(),
          body: z.unknown().optional(),
        }),
      })
    }
  }

  return operations.sort((a, b) => a.name.localeCompare(b.name))
}
