/**
 * Alpha rollout gate for OpenWork Cloud.
 *
 * Cloud is default-off for every organization. Platform admins must explicitly
 * enable the alpha with `metadata.capabilities.cloud: true`; absent and
 * non-boolean values stay disabled.
 *
 * The alpha is hosted-only: even a literal org opt-in is ignored unless Den is
 * running in multi-org mode. Keep this as the one place to relax the gate if
 * Cloud is later offered to self-hosted deployments.
 */

import type { DenOrgMode } from "../env.js"

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
      const parsed: unknown = JSON.parse(input)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return isRecord(input) ? input : {}
}

export function organizationCloudEnabled(
  metadata: MetadataInput,
  options: { orgMode: DenOrgMode },
): boolean {
  if (options.orgMode !== "multi_org") {
    return false
  }

  const parsed = parseMetadata(metadata)
  const capabilities = isRecord(parsed.capabilities) ? parsed.capabilities : {}
  return capabilities.cloud === true
}
