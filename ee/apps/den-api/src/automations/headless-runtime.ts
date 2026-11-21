import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { planIncludesHeadlessAutomations } from "../entitlements.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"

export const HEADLESS_AGENT_ENGINE_KIND = "openwork-headless-agent-v1"

export type CloudAutomationRuntime = "headless" | "web"

export function cloudAutomationRuntimeForOrganization(
  input: { metadata: Parameters<typeof planIncludesHeadlessAutomations>[0] },
  options: { env?: Record<string, string | undefined>; gatingEnabled?: boolean } = {},
): CloudAutomationRuntime {
  if (!planIncludesHeadlessAutomations(input.metadata, { gatingEnabled: options.gatingEnabled })) return "web"
  return headlessRunnerConfig(options.env ?? process.env) ? "headless" : "web"
}

export async function cloudAutomationRuntime(organizationId: string): Promise<CloudAutomationRuntime> {
  if (!headlessRunnerConfig()) return "web"
  const [organization] = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, normalizeDenTypeId("organization", organizationId)))
    .limit(1)
  if (!organization) return "web"
  return cloudAutomationRuntimeForOrganization({ metadata: organization.metadata })
}
