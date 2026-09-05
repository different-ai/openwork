import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation"

export type JsonSchemaObject = JsonSchemaType

export type CodemodeScriptPayload = {
  language: "codemode-js"
  inputSchema?: JsonSchemaObject
  outputSchema?: JsonSchemaObject
  exampleInput?: unknown
  requiredCapabilities: Array<{
    capabilityName: string
    scriptPath: string
  }>
  limits?: {
    timeoutMs?: number
    maxToolCalls?: number
    maxOutputBytes?: number
  }
}

export type CodemodeScriptInputIssue = {
  path: string
  keyword: "schema_validation"
  message: string
}

export type CodemodeScriptInputValidation =
  | { ok: true }
  | { ok: false; error: "invalid_arguments"; issues: CodemodeScriptInputIssue[] }
  | { ok: false; error: "invalid_schema"; message: string }

const validatorProvider = new AjvJsonSchemaValidator()
const VALIDATION_MESSAGE_LIMIT = 1_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isRecord(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isLimit(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

export function parseCodemodeScriptPayload(normalizedPayloadJson: unknown):
  | { ok: true; payload: CodemodeScriptPayload }
  | { ok: false; message: string } {
  if (!isRecord(normalizedPayloadJson) || !hasOnlyKeys(normalizedPayloadJson, ["language", "inputSchema", "outputSchema", "exampleInput", "requiredCapabilities", "limits"])) {
    return { ok: false, message: "The Workflow payload must contain only language, inputSchema, outputSchema, exampleInput, requiredCapabilities, and limits." }
  }
  if (normalizedPayloadJson.language !== "codemode-js") {
    return { ok: false, message: "The Workflow language must be codemode-js." }
  }
  if (normalizedPayloadJson.inputSchema !== undefined && !isJsonSchemaObject(normalizedPayloadJson.inputSchema)) {
    return { ok: false, message: "The Workflow inputSchema must be a JSON Schema object." }
  }
  if (normalizedPayloadJson.outputSchema !== undefined && !isJsonSchemaObject(normalizedPayloadJson.outputSchema)) {
    return { ok: false, message: "The Workflow outputSchema must be a JSON Schema object." }
  }
  if (!Array.isArray(normalizedPayloadJson.requiredCapabilities)) {
    return { ok: false, message: "The Workflow requiredCapabilities must be an array." }
  }

  const requiredCapabilities: CodemodeScriptPayload["requiredCapabilities"] = []
  for (const required of normalizedPayloadJson.requiredCapabilities) {
    if (
      !isRecord(required)
      || !hasOnlyKeys(required, ["capabilityName", "scriptPath"])
      || !isNonEmptyString(required.capabilityName)
      || !isNonEmptyString(required.scriptPath)
    ) {
      return { ok: false, message: "Each Workflow required capability must contain only non-empty capabilityName and scriptPath strings." }
    }
    requiredCapabilities.push({ capabilityName: required.capabilityName, scriptPath: required.scriptPath })
  }

  let limits: CodemodeScriptPayload["limits"]
  if (normalizedPayloadJson.limits !== undefined) {
    if (!isRecord(normalizedPayloadJson.limits) || !hasOnlyKeys(normalizedPayloadJson.limits, ["timeoutMs", "maxToolCalls", "maxOutputBytes"])) {
      return { ok: false, message: "The Workflow limits must contain only timeoutMs, maxToolCalls, and maxOutputBytes." }
    }
    const { timeoutMs, maxToolCalls, maxOutputBytes } = normalizedPayloadJson.limits
    if (timeoutMs !== undefined && !isLimit(timeoutMs, 1)) {
      return { ok: false, message: "The Workflow timeoutMs limit must be a positive safe integer." }
    }
    if (maxToolCalls !== undefined && !isLimit(maxToolCalls, 0)) {
      return { ok: false, message: "The Workflow maxToolCalls limit must be a non-negative safe integer." }
    }
    if (maxOutputBytes !== undefined && !isLimit(maxOutputBytes, 0)) {
      return { ok: false, message: "The Workflow maxOutputBytes limit must be a non-negative safe integer." }
    }
    limits = {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    }
  }

  return {
    ok: true,
    payload: {
      language: "codemode-js",
      ...(normalizedPayloadJson.inputSchema === undefined ? {} : { inputSchema: normalizedPayloadJson.inputSchema }),
      ...(normalizedPayloadJson.outputSchema === undefined ? {} : { outputSchema: normalizedPayloadJson.outputSchema }),
      ...(normalizedPayloadJson.exampleInput === undefined ? {} : { exampleInput: normalizedPayloadJson.exampleInput }),
      requiredCapabilities,
      ...(limits === undefined ? {} : { limits }),
    },
  }
}

export function validateCodemodeScriptOutput(schema: JsonSchemaObject, value: unknown): CodemodeScriptInputValidation {
  return validateCodemodeScriptInput(schema, value)
}

export function validateCodemodeScriptInput(schema: JsonSchemaObject, value: unknown): CodemodeScriptInputValidation {
  try {
    const result = validatorProvider.getValidator<unknown>(schema)(value)
    if (result.valid) return { ok: true }
    return {
      ok: false,
      error: "invalid_arguments",
      issues: [{
        path: "/",
        keyword: "schema_validation",
        message: result.errorMessage.length > VALIDATION_MESSAGE_LIMIT
          ? `${result.errorMessage.slice(0, VALIDATION_MESSAGE_LIMIT)}...`
          : result.errorMessage,
      }],
    }
  } catch {
    return {
      ok: false,
      error: "invalid_schema",
      message: "The Workflow input schema could not be compiled.",
    }
  }
}
