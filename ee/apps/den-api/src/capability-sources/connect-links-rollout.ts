/**
 * Deployment-level rollout for organization connect links.
 *
 * Mirrors install-links-rollout: hosted deployments keep the feature opt-in
 * per organization by enabling DEN_CONNECT_LINKS_GATING_ENABLED; self-hosted
 * deployments leave the gate off and get connect links as soon as a signing
 * key is configured.
 */

import { organizationHasCapability } from "../organization-capabilities.js"

type MetadataInput = Record<string, unknown> | string | null | undefined

export function organizationConnectLinksEnabled(
  metadata: MetadataInput,
  options: { gatingEnabled: boolean },
): boolean {
  return !options.gatingEnabled || organizationHasCapability(metadata, "connectLinks")
}
