/**
 * Staged-rollout gate for member-facing org MCP connections.
 *
 * When a deployment enables gating (DEN_MCP_CONNECTIONS_GATING_ENABLED=true,
 * see env.ts), members of an organization only discover connections once the
 * org opted in via the organization capability stored at
 * `metadata.capabilities.mcpConnections: true`. That per-org opt-in is
 * controlled from the /admin backoffice, not a script. Non-opted-in orgs get
 * an empty list — byte-identical to an org with no published connections, on
 * every desktop version in the field. Admin management (scope=manageable,
 * create, access grants) stays available so orgs can stage connections before
 * the capability flips.
 *
 * Gating is off by default so local dev, evals, and self-hosted deployments
 * keep the feature working out of the box.
 */

import { organizationHasCapability } from "../organization-capabilities.js"

export function memberFacingMcpConnectionsEnabled(
  metadata: Record<string, unknown> | string | null | undefined,
  options: { gatingEnabled: boolean },
): boolean {
  if (!options.gatingEnabled) {
    return true
  }
  return organizationHasCapability(metadata, "mcpConnections")
}
