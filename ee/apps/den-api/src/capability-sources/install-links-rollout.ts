/**
 * Deployment-level rollout for organization install links.
 *
 * Hosted deployments can keep the feature opt-in per organization by enabling
 * DEN_INSTALL_LINKS_GATING_ENABLED. Self-hosted deployments leave the gate off
 * and get organization downloads without a platform-admin toggle.
 */

import { organizationHasCapability } from "../organization-capabilities.js"

type MetadataInput = Record<string, unknown> | string | null | undefined

export function organizationInstallLinksEnabled(
  metadata: MetadataInput,
  options: { gatingEnabled: boolean },
): boolean {
  return !options.gatingEnabled || organizationHasCapability(metadata, "installLinks")
}
