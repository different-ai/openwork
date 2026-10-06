import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { planIncludesHeadlessAutomations } from "../entitlements.js"
import { headlessRunnerConfig } from "../infra/headless-runner/client.js"
import { organizationHasCapability } from "../organization-capabilities.js"

/** Engine kind recorded on cloud agent runs that executed on the headless runner. */
export const HEADLESS_AGENT_ENGINE_KIND = "openwork-headless-agent-v1"

/**
 * Where an organization's cloud agent Automations execute.
 *
 * - `headless`: the shared headless runner. No OpenWork Web computer, so no
 *   Web seat; included in Team.
 * - `web`: the owner's OpenWork Web computer, exactly as before.
 */
export type CloudAutomationRuntime = "headless" | "web"

export function cloudAutomationRuntimeForOrganization(
  metadata: Parameters<typeof organizationHasCapability>[0],
  options: { env?: Record<string, string | undefined>; gatingEnabled?: boolean } = {},
): CloudAutomationRuntime {
  if (!organizationHasCapability(metadata, "headlessAutomations")) return "web"
  if (!planIncludesHeadlessAutomations(metadata, { gatingEnabled: options.gatingEnabled })) return "web"
  return headlessRunnerConfig(options.env ?? process.env) ? "headless" : "web"
}

/** Read uncached, so a platform-admin switch applies to the next run. */
export async function cloudAutomationRuntime(organizationId: string): Promise<CloudAutomationRuntime> {
  // Deployments without a runner never look up the organization.
  if (!headlessRunnerConfig()) return "web"
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  return organization ? cloudAutomationRuntimeForOrganization(organization.metadata) : "web"
}
