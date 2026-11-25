import {
  managedInstallerLatestSchema,
  managedInstallerQualificationSchema,
  managedInstallerReportSchema,
  managedInstallerSourceInputSchema,
  managedInstallerValidationInputSchema,
  managedInstallerValidationSchema,
  type ManagedInstallerApprovalMode,
  type ManagedInstallerProviderState,
  type ManagedInstallerQualification,
  type ManagedInstallerValidation,
} from "@openwork/types/den/managed-installer-releases";

export const MANAGED_RELEASES_API = "/v1/admin/managed-releases";

export function parseManagedReport(payload: unknown) {
  const parsed = managedInstallerReportSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseManagedValidation(payload: unknown) {
  const parsed = managedInstallerValidationSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function parseManagedLatest(payload: unknown) {
  const parsed = managedInstallerLatestSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function sourceInputError(sourceBaseUrl: string, expectedRevision: string) {
  return managedInstallerSourceInputSchema.safeParse({ sourceBaseUrl: sourceBaseUrl.trim(), expectedRevision }).success
    ? null : "Enter a published release folder as an HTTPS address, without credentials or a fragment.";
}

export function versionInputError(state: ManagedInstallerProviderState, version: string) {
  return managedInstallerValidationInputSchema.safeParse({ provider: state.provider, version: version.trim(), expectedRevision: state.revision }).success
    ? null : "Enter a release version such as 1.2.3.";
}

export function pinBlockedReason(validation: ManagedInstallerValidation | null, state: ManagedInstallerProviderState, version: string, qualification: ManagedInstallerQualification, now: number, stale: boolean) {
  if (stale) return "The default changed. Refresh the current default, then verify this release again.";
  if (!validation || validation.provider !== state.provider || validation.release.version !== version.trim()) return "Verify this release before pinning it.";
  if (Date.parse(validation.expiresAt) <= now) return "Verification expired. Verify this release again.";
  if (!validation.canPin) return "Another platform administrator must pin this verified release.";
  if (!managedInstallerQualificationSchema.safeParse(qualification).success) return "Add HTTPS links to a successful fresh install and an approved update for this exact release.";
  return null;
}

export function managedApprovalLabel(mode: ManagedInstallerApprovalMode) {
  return mode === "independent_admin" ? "Second administrator" : "One administrator";
}

export function managedServiceLabel(service: string) {
  switch (service) {
    case "den_api": return "Den API";
    case "den_web": return "Den web";
    case "headless_runner": return "Managed runner";
    case "workbot": return "Workbot";
    case "ai_gateway": return "Model gateway";
    default: return service;
  }
}

export function managedSourceLabel(source: ManagedInstallerProviderState["source"]) {
  switch (source) {
    case "admin": return "Admin";
    case "environment": return "Environment";
    case "invalid_configuration": return "Invalid configuration";
    case "unconfigured": return "Not configured";
  }
}
