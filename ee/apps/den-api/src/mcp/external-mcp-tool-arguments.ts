import { createHash } from "node:crypto"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

export type ExternalMcpArgumentIssue = {
  path: string
  keyword: "schema_validation" | "type"
  message: string
}

export type ExternalMcpArgumentValidation =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; error: "invalid_arguments"; issues: ExternalMcpArgumentIssue[] }
  | { ok: false; error: "invalid_schema"; message: string }

const validatorProvider = new AjvJsonSchemaValidator()
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

export function externalMcpToolSchemaDigest(schema: Tool["inputSchema"]): string {
  return `sha256:${createHash("sha256").update(canonicalJson(schema)).digest("hex")}`
}

export function validateExternalMcpToolArguments(
  schema: Tool["inputSchema"],
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
    const result = validatorProvider.getValidator<Record<string, unknown>>(schema)(value)
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
  } catch {
    return {
      ok: false,
      error: "invalid_schema",
      message: "The remote MCP tool advertised an input schema that OpenWork could not compile.",
    }
  }
}
