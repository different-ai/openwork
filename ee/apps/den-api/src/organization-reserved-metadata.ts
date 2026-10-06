/**
 * Organization metadata keys that only platform administration may write.
 * Features are not here: they live in organization_feature, and
 * beforeCreateOrganization drops any client-supplied `capabilities` object.
 */
export const RESERVED_ORGANIZATION_METADATA_KEYS = [
  "dpaSigned",
  "plan",
  "limits",
  "seatsFreeAdditional",
  "inference",
  "inferenceFree",
] as const

/** Returns the first platform-admin-only key in creation metadata, or null. */
export function findReservedOrganizationMetadataKey(metadata: Record<string, unknown>): string | null {
  return RESERVED_ORGANIZATION_METADATA_KEYS.find((key) => key in metadata) ?? null
}
