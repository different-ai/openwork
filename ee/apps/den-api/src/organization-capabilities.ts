import { z } from "zod"

/**
 * Per-organization capability flags ("org capabilities").
 *
 * Capabilities let platform admins enable shipped-but-dark features
 * org-by-org from the /admin backoffice. Every capability defaults to OFF
 * for every organization; only an explicit `true` in the organization's
 * metadata JSON (`metadata.capabilities.<key>`) turns one on.
 *
 * Storage rides the existing organization metadata JSON column — the same
 * home as `limits`, `plan`, and `requireSso` — so no schema change is needed.
 */
export const ORGANIZATION_CAPABILITY_KEYS = ["installLinks"] as const

export const organizationCapabilityKeySchema = z.enum(ORGANIZATION_CAPABILITY_KEYS)

export type OrganizationCapabilityKey = z.infer<typeof organizationCapabilityKeySchema>

export type OrganizationCapabilities = Record<OrganizationCapabilityKey, boolean>

type MetadataInput = Record<string, unknown> | string | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseMetadata(input: MetadataInput): Record<string, unknown> {
  if (!input) {
    return {}
  }

  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

/** Every capability key resolved to a boolean, defaulting to false. */
export function normalizeOrganizationCapabilities(metadata: MetadataInput): OrganizationCapabilities {
  const parsed = parseMetadata(metadata)
  const raw = isRecord(parsed.capabilities) ? parsed.capabilities : {}

  return {
    installLinks: raw.installLinks === true,
  }
}

/** Whether the organization has an explicit opt-in for the capability. */
export function organizationHasCapability(metadata: MetadataInput, key: OrganizationCapabilityKey): boolean {
  return normalizeOrganizationCapabilities(metadata)[key]
}
