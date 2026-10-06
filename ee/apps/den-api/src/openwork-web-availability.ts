import { readFeatureRollouts, readOrganizationFeatureOverrides } from "@openwork-ee/den-db/organization-features"
import { resolveFeature, type FeatureOverrides, type FeatureRollouts } from "@openwork/features"
import { db } from "./db.js"
import { env } from "./env.js"
import { hasOpenWorkWebComplimentaryAccess } from "./openwork-web-access.js"

/**
 * OpenWork Web is the `openworkWeb` feature: cloud only, so it does not exist
 * on self-hosted installs. Whether an organization may use it is still billing
 * (subscription or the platform-admin complimentary grant); a grant counts only
 * where Web exists here and is not turned off everywhere.
 */
export type OpenWorkWebDeployment = {
  /** Offered to everyone on this deployment (feature on, not killed). */
  offered: boolean
  /** Part of this deployment and not killed, so complimentary grants apply. */
  exists: boolean
}

export function openWorkWebDeployment(rollouts: FeatureRollouts, overrides: FeatureOverrides = {}): OpenWorkWebDeployment {
  const resolved = resolveFeature("openworkWeb", { ...env.features, rollouts, overrides })
  return { offered: resolved.enabled, exists: resolved.source !== "unavailable" && resolved.source !== "killed" }
}

export async function readOpenWorkWebDeployment(): Promise<OpenWorkWebDeployment> {
  return openWorkWebDeployment(await readFeatureRollouts(db))
}

/** Offered to everyone on this deployment. */
export async function isOpenWorkWebAvailable(): Promise<boolean> {
  return (await readOpenWorkWebDeployment()).offered
}

/** Offered to this organization: on for it, or granted to it where Web exists. */
export async function isOpenWorkWebAvailableForOrganization(
  organizationId: string,
  metadata: Record<string, unknown> | string | null | undefined,
): Promise<boolean> {
  const [rollouts, overrides] = await Promise.all([readFeatureRollouts(db), readOrganizationFeatureOverrides(db, organizationId)])
  const web = openWorkWebDeployment(rollouts, overrides)
  return web.offered || (web.exists && hasOpenWorkWebComplimentaryAccess(metadata))
}
