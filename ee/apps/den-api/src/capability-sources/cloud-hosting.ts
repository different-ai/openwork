/**
 * Deployment-level availability of OpenWork Cloud.
 *
 * Multi-org Den deployments (hosted OpenWork Cloud) always offer Cloud. A
 * self-hosted single-org install offers it only when its operator turns on
 * OpenWork Web (DEN_OPENWORK_WEB_ENABLED); the routes still need a configured
 * runtime provider (cloudRuntimeAvailable). Whether a specific organization may
 * actually run Cloud work is an entitlement question answered by OpenWork Web
 * access (a paid subscription or the platform-admin complimentary grant), not
 * by a per-organization rollout flag. Keep this as the one place that decides
 * the hosting boundary.
 *
 * Single-org installs that leave OpenWork Web off keep receiving 404
 * cloud_not_found from the Cloud routes, as before.
 */

import type { DenOrgMode } from "../env.js"

export function cloudHostingAvailable(options: { orgMode: DenOrgMode; openworkWebEnabled: boolean }): boolean {
  return options.orgMode === "multi_org" || options.openworkWebEnabled
}
