import { z } from "zod"
import {
  openWorkExtensionManifestCatalogV1Schema,
  openWorkExtensionManifestV1Schema,
  type OpenWorkExtensionManifest,
  type OpenWorkExtensionManifestCatalogV1,
} from "./schemas.js"

export type OpenWorkExtensionValidationContract =
  | "openwork-extension-manifest-v1"
  | "openwork-extension-manifest-catalog-v1"

export type OpenWorkExtensionValidationIssueCode =
  | "duplicate"
  | "invalid_format"
  | "invalid_type"
  | "invalid_value"
  | "size_limit"

export type OpenWorkExtensionValidationPathSegment = string | number

export type OpenWorkExtensionValidationIssue = Readonly<{
  code: OpenWorkExtensionValidationIssueCode
  message: string
  path: readonly OpenWorkExtensionValidationPathSegment[]
}>

export type OpenWorkExtensionValidationError = Readonly<{
  code: "OPENWORK_EXTENSION_CONTRACT_INVALID"
  contract: OpenWorkExtensionValidationContract
  issues: readonly OpenWorkExtensionValidationIssue[]
  message: string
}>

export type OpenWorkExtensionValidationResult<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ error: OpenWorkExtensionValidationError; ok: false }>

function normalizeIssueCode(issue: z.ZodIssue): OpenWorkExtensionValidationIssueCode {
  switch (issue.code) {
    case "invalid_type":
      return "invalid_type"
    case "invalid_format":
      return "invalid_format"
    case "too_big":
    case "too_small":
      return "size_limit"
    case "custom":
      return issue.message.startsWith("Duplicate ") ? "duplicate" : "invalid_value"
    default:
      return "invalid_value"
  }
}

function normalizePath(path: readonly PropertyKey[]): readonly OpenWorkExtensionValidationPathSegment[] {
  return Object.freeze(path.map((segment) =>
    typeof segment === "string" || typeof segment === "number" ? segment : String(segment)))
}

function normalizeValidationError(
  contract: OpenWorkExtensionValidationContract,
  error: z.ZodError,
): OpenWorkExtensionValidationError {
  const issues = Object.freeze(error.issues.map((issue) => Object.freeze({
    code: normalizeIssueCode(issue),
    message: issue.message,
    path: normalizePath(issue.path),
  })))
  return Object.freeze({
    code: "OPENWORK_EXTENSION_CONTRACT_INVALID",
    contract,
    issues,
    message: `Invalid ${contract}.`,
  })
}

export function validateOpenWorkExtensionManifest(
  input: unknown,
): OpenWorkExtensionValidationResult<OpenWorkExtensionManifest> {
  const result = openWorkExtensionManifestV1Schema.safeParse(input)
  if (result.success) return Object.freeze({ ok: true, value: result.data })
  return Object.freeze({
    error: normalizeValidationError("openwork-extension-manifest-v1", result.error),
    ok: false,
  })
}

export function validateOpenWorkExtensionManifestCatalog(
  input: unknown,
): OpenWorkExtensionValidationResult<OpenWorkExtensionManifestCatalogV1> {
  const result = openWorkExtensionManifestCatalogV1Schema.safeParse(input)
  if (result.success) return Object.freeze({ ok: true, value: result.data })
  return Object.freeze({
    error: normalizeValidationError("openwork-extension-manifest-catalog-v1", result.error),
    ok: false,
  })
}
