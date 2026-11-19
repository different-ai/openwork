import type { OpenworkSandboxSettingsResponse } from "../../../../app/lib/openwork-server";

export type HostExecutionRowNote = "managed" | "sandbox_unavailable" | "sandbox_only" | "pending_host" | "pending_sandbox" | null;

export type HostExecutionRow = {
  visible: boolean;
  hostToolsAllowed: boolean;
  desiredHostToolsAllowed: boolean;
  lockedByOrganization: boolean;
  note: HostExecutionRowNote;
};

export function hostExecutionRow(settings: OpenworkSandboxSettingsResponse | null, rolloutEnabled: boolean): HostExecutionRow {
  if (!settings) return { visible: false, hostToolsAllowed: true, desiredHostToolsAllowed: true, lockedByOrganization: false, note: null };
  const hostToolsAllowed = settings.effectiveAllowHostExecution;
  const desiredHostToolsAllowed = settings.allowHostExecution && !settings.managed;
  const sandboxAvailable = rolloutEnabled && settings.featureEnabled;
  const requirementStandsWithoutRollout = !desiredHostToolsAllowed || !hostToolsAllowed || settings.pending === true;
  return {
    visible: rolloutEnabled || requirementStandsWithoutRollout,
    hostToolsAllowed,
    desiredHostToolsAllowed,
    lockedByOrganization: settings.managed,
    note: settings.pending ? hostToolsAllowed ? "pending_host" : "pending_sandbox"
      : settings.managed ? "managed" : hostToolsAllowed ? null : sandboxAvailable ? "sandbox_only" : "sandbox_unavailable",
  };
}

export function withOwnHostExecutionSetting(settings: OpenworkSandboxSettingsResponse, allowHostExecution: boolean): OpenworkSandboxSettingsResponse {
  return { ...settings, allowHostExecution, pending: (allowHostExecution && !settings.managed) !== settings.effectiveAllowHostExecution };
}
