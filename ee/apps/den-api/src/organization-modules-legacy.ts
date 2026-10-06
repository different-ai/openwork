import type { OrganizationModules } from "@openwork-ee/den-db/organization-modules"
import { memberFacingMcpConnectionsEnabled } from "./capability-sources/external-mcp-rollout.js"
import { organizationInstallLinksEnabled } from "./capability-sources/install-links-rollout.js"

/**
 * Legacy default-on kill switches that map onto `organization.modules.disabled`
 * (modules README rule R7, 00-legacy-mapping §G). Grant capabilities stay in
 * `metadata.capabilities` and are never copied into the column.
 */
export const LEGACY_KILL_SWITCH_MODULES = ["connect", "installLinks"] as const
export type LegacyKillSwitchModule = (typeof LEGACY_KILL_SWITCH_MODULES)[number]

type MetadataInput = Record<string, unknown> | string | null | undefined

function killSwitchEnabled(module: LegacyKillSwitchModule, metadata: MetadataInput): boolean {
  return module === "connect" ? memberFacingMcpConnectionsEnabled(metadata) : organizationInstallLinksEnabled(metadata)
}

/** §G.1: the modules an explicit legacy `false` turns off, sorted. */
export function legacyDisabledModules(metadata: MetadataInput): LegacyKillSwitchModule[] {
  return LEGACY_KILL_SWITCH_MODULES.filter((module) => !killSwitchEnabled(module, metadata))
}

export type LegacyKillSwitchChanges = { disable: LegacyKillSwitchModule[]; enable: LegacyKillSwitchModule[] }

/** §G.3: which kill switches one metadata write turned off or back on. */
export function legacyKillSwitchChanges(before: MetadataInput, after: MetadataInput): LegacyKillSwitchChanges {
  const disable: LegacyKillSwitchModule[] = []
  const enable: LegacyKillSwitchModule[] = []
  for (const module of LEGACY_KILL_SWITCH_MODULES) {
    const wasEnabled = killSwitchEnabled(module, before)
    const isEnabled = killSwitchEnabled(module, after)
    if (wasEnabled && !isEnabled) disable.push(module)
    if (!wasEnabled && isEnabled) enable.push(module)
  }
  return { disable, enable }
}

/** Applies kill-switch changes to `disabled`, leaving every other entry alone. */
export function applyLegacyKillSwitchChanges(doc: OrganizationModules, changes: LegacyKillSwitchChanges): OrganizationModules {
  const enabled = new Set<string>(changes.enable)
  const disabled = doc.disabled.filter((module) => !enabled.has(module))
  return { ...doc, disabled: [...disabled, ...changes.disable] }
}
