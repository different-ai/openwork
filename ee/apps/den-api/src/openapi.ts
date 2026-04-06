import { resolver } from "hono-openapi"
import { z } from "zod"

function toPascalCase(value: string) {
  return value
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")
}

export function buildOperationId(method: string, path: string) {
  const parts = path
    .split("/")
    .filter(Boolean)
    .filter((part) => part !== "v1")
    .map((part) => {
      if (part.startsWith(":")) {
        return `by-${part.slice(1)}`
      }

      if (part === "*") {
        return "wildcard"
      }

      return part
    })

  return [method.toLowerCase(), ...parts]
    .map(toPascalCase)
    .join("")
    .replace(/^[A-Z]/, (char) => char.toLowerCase())
}

const validationIssueSchema = z.object({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
}).passthrough()

export const invalidRequestSchema = z.object({
  error: z.literal("invalid_request"),
  details: z.array(validationIssueSchema),
}).meta({ ref: "InvalidRequestError" })

export const unauthorizedSchema = z.object({
  error: z.literal("unauthorized"),
}).meta({ ref: "UnauthorizedError" })

export const forbiddenSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string().optional(),
}).meta({ ref: "ForbiddenError" })

export const notFoundSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
}).meta({ ref: "NotFoundError" })

export const successSchema = z.object({
  success: z.literal(true),
}).meta({ ref: "SuccessResponse" })

export const emptyObjectSchema = z.object({}).passthrough().meta({ ref: "OpaqueObject" })

export function jsonResponse(description: string, schema: z.ZodTypeAny) {
  return {
    description,
    content: {
      "application/json": {
        schema: resolver(schema),
      },
    },
  }
}

export function htmlResponse(description: string) {
  return {
    description,
    content: {
      "text/html": {
        schema: resolver(z.string()),
      },
    },
  }
}

export function textResponse(description: string) {
  return {
    description,
    content: {
      "text/plain": {
        schema: resolver(z.string()),
      },
    },
  }
}

export function emptyResponse(description: string) {
  return { description }
}
