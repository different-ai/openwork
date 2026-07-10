import { z } from "zod"

/**
 * Per-organization capability flags ("org capabilities").
 *
 * Capabilities let platform admins enable shipped-but-dark features
 * org-by-org from the /admin backoffice. Callers may provide deployment-level
 * defaults for capabilities that should work out of the box when self-hosted;
 * an explicit organization value always wins.
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
export function normalizeOrganizationCapabilities(
  metadata: MetadataInput,
  defaults: Partial<OrganizationCapabilities> = {},
): OrganizationCapabilities {
  const parsed = parseMetadata(metadata)
  const raw = isRecord(parsed.capabilities) ? parsed.capabilities : {}

  return {
    installLinks: raw.installLinks === undefined ? defaults.installLinks === true : raw.installLinks === true,
    mcpConnections: raw.mcpConnections === undefined ? defaults.mcpConnections === true : raw.mcpConnections === true,
  }
}

/** Resolve a capability after applying any deployment-level defaults. */
export function organizationHasCapability(
  metadata: MetadataInput,
  key: OrganizationCapabilityKey,
  defaults?: Partial<OrganizationCapabilities>,
): boolean {
  return normalizeOrganizationCapabilities(metadata, defaults)[key]
}
