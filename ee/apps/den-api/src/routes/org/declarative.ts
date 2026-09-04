import type { Context } from "hono"
import type { OrgRouteVariables } from "./shared.js"
import { z } from "zod"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"

export const externalKeyParamsSchema = z.object({
  externalKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
})

export const declarativeConflictSchema = z.object({ error: z.string(), message: z.string().optional() })
export const declarativeDeleteSchema = z.object({ ok: z.literal(true), deleted: z.boolean() })

export function declarativeResponses(schema: z.ZodType) {
  return {
    200: jsonResponse("The existing resource was replaced.", schema),
    201: jsonResponse("The resource was created.", schema),
    400: jsonResponse("Invalid declarative request.", invalidRequestSchema),
    401: jsonResponse("Authentication required.", unauthorizedSchema),
    403: jsonResponse("Resource management permission required.", forbiddenSchema),
    404: jsonResponse("A referenced resource was not found.", notFoundSchema),
    409: jsonResponse("A name or identity conflict requires reconciliation.", declarativeConflictSchema),
  }
}

// Drizzle wraps driver errors in `cause`. Never return SQL (which can contain
// credentials) to a provisioning client.
export function isDuplicateEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "ER_DUP_ENTRY") return true
  if ("errno" in error && error.errno === 1062) return true
  return "cause" in error && error.cause !== error && isDuplicateEntry(error.cause)
}

export type ResourceActionContext = Pick<Context, "json" | "body"> & {
  get: <K extends "apiKey" | "organizationContext" | "session">(key: K) => OrgRouteVariables[K]
}
export type ResourceOrganizationContext = NonNullable<OrgRouteVariables["organizationContext"]>
