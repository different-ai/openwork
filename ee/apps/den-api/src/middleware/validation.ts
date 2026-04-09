import { validator as zValidator } from "hono-openapi"
import type { ZodSchema } from "zod"

function invalidRequestResponse(result: { success: false; error: unknown }, c: { json: (body: unknown, status?: number) => Response }) {
  return c.json(
    {
      error: "invalid_request",
      details: result.error,
    },
    400,
  )
}

export function jsonValidator<T extends ZodSchema>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return invalidRequestResponse(result, c)
    }
  })
}

export function queryValidator<T extends ZodSchema>(schema: T) {
  return zValidator("query", schema, (result, c) => {
    if (!result.success) {
      return invalidRequestResponse(result, c)
    }
  })
}

export function paramValidator<T extends ZodSchema>(schema: T) {
  return zValidator("param", schema, (result, c) => {
    if (!result.success) {
      return invalidRequestResponse(result, c)
    }
  })
}
