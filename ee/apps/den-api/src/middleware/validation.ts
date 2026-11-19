import type { StandardSchemaV1 } from "@standard-schema/spec"
import { validator as zValidator } from "hono-openapi"
import type { ZodSchema } from "zod"

function issuePath(issue: StandardSchemaV1.Issue): string {
  return (issue.path ?? [])
    .map((segment) => (typeof segment === "object" ? segment.key : segment))
    .map(String)
    .join(".")
}

/** "requestedScopes: Too big: expected array to have <=512 items", so clients have something to show. */
export function validationIssuesMessage(issues: readonly StandardSchemaV1.Issue[]): string {
  const first = issues[0]
  if (!first) return "The request was invalid."
  const path = issuePath(first)
  const summary = path ? `${path}: ${first.message}` : first.message
  return issues.length > 1 ? `${summary} (and ${issues.length - 1} more)` : summary
}

function invalidRequestResponse(
  result: { success: false; error: readonly StandardSchemaV1.Issue[] },
  c: { json: (body: unknown, status?: number) => Response },
) {
  return c.json(
    {
      error: "invalid_request",
      message: validationIssuesMessage(result.error),
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
