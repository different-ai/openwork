import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { AutomationExecutionTarget } from "@openwork/types/automations"
import { readOrganizationAutomationSettings, type OrganizationAutomationSettings } from "@openwork/types/den/automation-settings"
import { db } from "../db.js"
import { env } from "../env.js"
import { headlessRunnerConfig } from "../headless-runner/client.js"

export type OrganizationAutomationAvailability = {
  /** The organization's own choice; both true until an admin turns one off. */
  settings: OrganizationAutomationSettings
  /** Whether this deployment can run Cloud Automations headlessly at all. */
  headlessRunnerConfigured: boolean
  desktop: boolean
  cloud: boolean
}

export function headlessAutomationsConfigured(source: Record<string, string | undefined> = process.env) {
  return headlessRunnerConfig(source) !== null
}

/** What an organization may run now: its settings, deployment switches and, for Cloud, the headless runner. */
export function automationAvailabilityFor(input: {
  metadata: unknown
  headlessRunnerConfigured: boolean
}): OrganizationAutomationAvailability {
  const settings = readOrganizationAutomationSettings(input.metadata)
  return {
    settings,
    headlessRunnerConfigured: input.headlessRunnerConfigured,
    desktop: env.automations.enabled && settings.desktop,
    cloud: env.automations.runtimeEnabled && input.headlessRunnerConfigured && settings.cloud,
  }
}

export async function organizationAutomationAvailability(organizationId: string): Promise<OrganizationAutomationAvailability> {
  const id = normalizeDenTypeId("organization", organizationId)
  const [organization] = await db.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, id)).limit(1)
  return automationAvailabilityFor({ metadata: organization?.metadata ?? null, headlessRunnerConfigured: headlessAutomationsConfigured() })
}

export async function automationTargetAllowed(organizationId: string, target: AutomationExecutionTarget) {
  return (await organizationAutomationAvailability(organizationId))[target]
}
