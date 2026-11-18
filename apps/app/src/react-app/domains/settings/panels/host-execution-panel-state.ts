import type { OpenworkSandboxSettingsResponse } from "../../../../app/lib/openwork-server";

export type HostExecutionRowNote = "managed" | "sandbox_unavailable" | "sandbox_only" | null;

export type HostExecutionRow = {
  visible: boolean;
  hostToolsAllowed: boolean;
  lockedByOrganization: boolean;
  note: HostExecutionRowNote;
};

export function hostExecutionRow(settings: OpenworkSandboxSettingsResponse | null, rolloutEnabled: boolean): HostExecutionRow {
  if (!settings) return { visible: false, hostToolsAllowed: true, lockedByOrganization: false, note: null };
  const hostToolsAllowed = settings.allowHostExecution && settings.effectiveAllowHostExecution && !settings.managed;
  const sandboxAvailable = rolloutEnabled && settings.featureEnabled;
  const requirementStandsWithoutRollout = !hostToolsAllowed;
  return {
    visible: rolloutEnabled || requirementStandsWithoutRollout,
    hostToolsAllowed,
    lockedByOrganization: settings.managed,
    note: hostToolsAllowed ? null : settings.managed ? "managed" : sandboxAvailable ? "sandbox_only" : "sandbox_unavailable",
  };
}

export function withOwnHostExecutionSetting(settings: OpenworkSandboxSettingsResponse, allowHostExecution: boolean): OpenworkSandboxSettingsResponse {
  return { ...settings, allowHostExecution, effectiveAllowHostExecution: allowHostExecution && !settings.managed };
}
