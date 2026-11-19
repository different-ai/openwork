import { z } from "zod";

/**
 * Which kinds of Automations an organization allows. Desktop Automations run on a member's signed-in desktop;
 * Cloud Automations run headlessly in OpenWork Cloud and also need the deployment's headless runner.
 * A missing setting means allowed: Automations are on unless an admin turns a kind off.
 */
export const organizationAutomationSettingsSchema = z.object({
  desktop: z.boolean(),
  cloud: z.boolean(),
});

export type OrganizationAutomationSettings = z.infer<typeof organizationAutomationSettingsSchema>;

export const DEFAULT_ORGANIZATION_AUTOMATION_SETTINGS: OrganizationAutomationSettings = { desktop: true, cloud: true };

/** Organization metadata key holding the setting. */
export const ORGANIZATION_AUTOMATION_SETTINGS_KEY = "automations";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (isRecord(metadata)) return metadata;
  if (typeof metadata !== "string") return null;
  // Some readers hand back the stored JSON column text.
  try {
    const parsed: unknown = JSON.parse(metadata);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readOrganizationAutomationSettings(metadata: unknown): OrganizationAutomationSettings {
  const stored = metadataRecord(metadata)?.[ORGANIZATION_AUTOMATION_SETTINGS_KEY];
  if (!isRecord(stored)) return { ...DEFAULT_ORGANIZATION_AUTOMATION_SETTINGS };
  return {
    desktop: typeof stored.desktop === "boolean" ? stored.desktop : true,
    cloud: typeof stored.cloud === "boolean" ? stored.cloud : true,
  };
}

export function withOrganizationAutomationSettings(
  metadata: Record<string, unknown> | null | undefined,
  settings: Partial<OrganizationAutomationSettings>,
): Record<string, unknown> {
  const current = readOrganizationAutomationSettings(metadata);
  return { ...(metadata ?? {}), [ORGANIZATION_AUTOMATION_SETTINGS_KEY]: { ...current, ...settings } };
}
