import {
  parseOrganizationModulesColumn,
  readOrganizationModulesRevision,
  type OrganizationModules,
} from "@openwork-ee/den-db/organization-modules"

/**
 * The three organization columns the runtime needs. Every caller already has
 * them (`organizationModuleStateColumns` from den-db, or den-api's
 * `OrganizationContext.organization`).
 */
export type OrgModuleRow = {
  /** Organization id. */
  readonly id: string
  /** `organization.metadata`: object, JSON string or null. */
  readonly metadata: unknown
  /** `organization.modules`: the raw column (object, JSON string or null) or an already parsed document. */
  readonly modules: unknown
}

export type OrgModulesDocument =
  | { readonly status: "absent"; readonly doc: null }
  | { readonly status: "valid"; readonly doc: OrganizationModules }
  | { readonly status: "invalid"; readonly doc: null; readonly issues: readonly string[] }

/** Memo key part: the document revision, `0` for NULL, `x` when unreadable. Never parses the schema. */
export function revisionKey(row: OrgModuleRow): string {
  const revision = readOrganizationModulesRevision(row.modules)
  return revision === null ? "x" : String(revision)
}

/** Full parse (memo miss only). An invalid document is reported and then treated like NULL. */
export function parseOrgModulesDocument(row: OrgModuleRow): OrgModulesDocument {
  const parsed = parseOrganizationModulesColumn(row.modules)
  if (parsed.status === "valid") return { status: "valid", doc: parsed.doc }
  if (parsed.status === "absent") return { status: "absent", doc: null }
  return { status: "invalid", doc: null, issues: parsed.issues }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * Same parsing as den-api's legacy helpers (`organization-capabilities.ts`
 * `parseMetadata`): a JSON string is decoded, anything that is not an object
 * becomes `{}`. Never throws.
 */
export function parseOrgMetadata(input: unknown): Record<string, unknown> {
  if (!input) return {}
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isRecord(input) ? input : {}
}

export function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}
