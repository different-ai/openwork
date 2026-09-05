import { z } from "zod"

/**
 * Per-organization capability flags ("org capabilities").
 *
 * Capabilities let platform admins manage feature switches org-by-org from the
 * /admin backoffice. The helpers here expose the raw stored booleans;
 * feature-specific rollout helpers can layer effective default-on kill-switch
 * semantics for member-facing surfaces.
 *
 * Storage rides the existing organization metadata JSON column — the same
 * home as `limits`, `plan`, and `requireSso` — so no schema change is needed.
 */
export const ORGANIZATION_CAPABILITY_KEYS = ["installLinks", "mcpConnections"] as const

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
    mcpConnections: raw.mcpConnections === true,
  }
}

/** Only raw, literal org capability overrides that are explicitly stored. */
export function readOrganizationCapabilityOverrides(metadata: MetadataInput): Partial<OrganizationCapabilities> {
  const parsed = parseMetadata(metadata)
  const raw = isRecord(parsed.capabilities) ? parsed.capabilities : {}
  const capabilities: Partial<OrganizationCapabilities> = {}

  if (typeof raw.installLinks === "boolean") {
    capabilities.installLinks = raw.installLinks
  }
  if (typeof raw.mcpConnections === "boolean") {
    capabilities.mcpConnections = raw.mcpConnections
  }

  return capabilities
}

/** Whether the organization stores an explicit literal true for the capability. */
export function organizationHasCapability(metadata: MetadataInput, key: OrganizationCapabilityKey): boolean {
  return normalizeOrganizationCapabilities(metadata)[key]
}
