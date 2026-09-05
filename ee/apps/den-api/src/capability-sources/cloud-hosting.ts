/**
 * Deployment-level availability of OpenWork Cloud.
 *
 * Cloud is hosted-only: it is offered on multi-org Den deployments and never
 * on self-hosted single-org installs. Whether a specific organization may
 * actually run Cloud work is an entitlement question answered by OpenWork
 * Web access (a paid subscription or the platform-admin complimentary grant),
 * not by a per-organization rollout flag. Keep this as the one place to relax
 * the hosting boundary if Cloud is later offered to self-hosted deployments.
 *
 * Wire behavior for published desktops is unchanged: the retired rollout gate
 * also returned false for every non-multi_org deployment, so single-org
 * installs already received 404 cloud_not_found from the Cloud routes
 * regardless of provisioner or organization metadata.
 */

import type { DenOrgMode } from "../env.js"

export function cloudHostingAvailable(options: { orgMode: DenOrgMode }): boolean {
  return options.orgMode === "multi_org"
}
