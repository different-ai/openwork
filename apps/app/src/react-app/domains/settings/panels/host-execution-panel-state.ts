import type { OpenworkSandboxSettingsResponse } from "../../../../app/lib/openwork-server";

export type HostExecutionRowNote = "managed" | "sandbox_unavailable" | "pending_host" | "pending_sandbox" | null;
export type SandboxRuntimeStatus = "idle" | "starting" | "ready" | "unsupported" | "failed" | null;

export function hostExecutionRow(settings: OpenworkSandboxSettingsResponse | null, rolloutEnabled: boolean) {
  const hostToolsAllowed = settings?.effectiveAllowHostExecution ?? true;
  const desiredHostToolsAllowed = settings?.managed ? hostToolsAllowed : settings?.allowHostExecution ?? true;
  return {
    visible: rolloutEnabled,
    hostToolsAllowed,
    desiredHostToolsAllowed,
    lockedByOrganization: settings?.managed ?? false,
    sandboxFolders: Boolean(settings && (!hostToolsAllowed || !desiredHostToolsAllowed)),
    note: settings?.pending ? hostToolsAllowed ? "pending_host" : "pending_sandbox"
      : settings?.managed ? "managed" : settings && !settings.featureEnabled && !hostToolsAllowed ? "sandbox_unavailable" : null,
  } satisfies { note: HostExecutionRowNote; visible: boolean; hostToolsAllowed: boolean; desiredHostToolsAllowed: boolean; lockedByOrganization: boolean; sandboxFolders: boolean };
}

export function sandboxRuntimeStatus(settings: OpenworkSandboxSettingsResponse | null): SandboxRuntimeStatus {
  if (!settings || settings.effectiveAllowHostExecution) return null;
  if (!settings.featureEnabled) return "unsupported";
  return settings.runtime?.state ?? null;
}

export function canPrepareSandbox(settings: OpenworkSandboxSettingsResponse | null | undefined) {
  return Boolean(settings?.featureEnabled && !settings.effectiveAllowHostExecution && !settings.pending && settings.runtime?.state === "idle");
}

export function canRetrySandbox(settings: OpenworkSandboxSettingsResponse | null | undefined) {
  return Boolean(settings?.featureEnabled && !settings.effectiveAllowHostExecution && !settings.pending && (settings.runtime?.state === "failed" || settings.runtime?.state === "unsupported") && settings.runtime.canRetry);
}

export function withOwnHostExecutionSetting(settings: OpenworkSandboxSettingsResponse, allowHostExecution: boolean): OpenworkSandboxSettingsResponse {
  if (settings.managed) return settings;
  return { ...settings, allowHostExecution, pending: allowHostExecution !== settings.effectiveAllowHostExecution };
}
