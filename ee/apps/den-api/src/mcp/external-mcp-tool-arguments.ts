import { createHash } from "node:crypto"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv"
import { SCHEMA_CHECK_TIME_LIMIT_MS, SCHEMA_CHECK_TOO_SLOW_MESSAGE, TimeLimitExceededError, runWithTimeLimit } from "../time-limit.js"

export type ExternalMcpArgumentIssue = {
  path: string
  keyword: "schema_validation" | "type"
  message: string
}

export type ExternalMcpArgumentValidation =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; error: "invalid_arguments"; issues: ExternalMcpArgumentIssue[] }
  | { ok: false; error: "invalid_schema"; message: string }

let validatorProvider = new AjvJsonSchemaValidator()
const VALIDATION_MESSAGE_LIMIT = 1_000

function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function boundedMessage(message: string): string {
  return message.length > VALIDATION_MESSAGE_LIMIT
    ? `${message.slice(0, VALIDATION_MESSAGE_LIMIT)}...`
    : message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function externalMcpToolSchemaDigest(schema: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(schema)).digest("hex")}`
}

export function validateExternalMcpToolArguments(
  schema: Record<string, unknown>,
  value: unknown,
): ExternalMcpArgumentValidation {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: "invalid_arguments",
      issues: [{
        path: "/",
        keyword: "type",
        message: "Remote MCP capability arguments must be a JSON object.",
      }],
    }
  }

  try {
    // The remote server wrote this schema's patterns: see runWithTimeLimit.
    const result = runWithTimeLimit(() => validatorProvider.getValidator<Record<string, unknown>>(schema)(value), SCHEMA_CHECK_TIME_LIMIT_MS)
    if (result.valid) return { ok: true, arguments: value }
    return {
      ok: false,
      error: "invalid_arguments",
      issues: [{
        path: "/",
        keyword: "schema_validation",
        message: boundedMessage(result.errorMessage),
      }],
    }
  } catch (error) {
    if (error instanceof TimeLimitExceededError) {
      // The stopped check may have left this validator half-way through compiling.
      validatorProvider = new AjvJsonSchemaValidator()
      return { ok: false, error: "invalid_arguments", issues: [{ path: "/", keyword: "schema_validation", message: SCHEMA_CHECK_TOO_SLOW_MESSAGE }] }
    }
    return {
      ok: false,
      error: "invalid_schema",
      message: "The remote MCP tool advertised an input schema that OpenWork could not compile.",
    }
  }
}
