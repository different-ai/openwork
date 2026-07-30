import type { DenCloudInstance } from "@/app/lib/den";

export type CloudWorkspacePillVariant =
  | "ready"
  | "stale"
  | "waking"
  | "provisioning"
  | "updating"
  | "failed";

export type CloudWorkspaceViewModel = {
  variant: CloudWorkspacePillVariant;
  label: string;
  tone: "neutral" | "amber";
  statusLine: string;
  computerLine: string | null;
  versionLine: string;
  latestLine: string;
  backupsLine: string;
  updateAvailable: boolean;
  showUpdate: boolean;
  showRetry: boolean;
  pollMs: number;
};

export type CloudWorkspaceMainContentDecision = "takeover" | "error" | "content";

export function formatCloudWorkspaceVersion(version: string | null): string | null {
  const trimmed = version?.trim() ?? "";
  if (!trimmed) return null;
  const openworkPrefix = "openwork-";
  if (!trimmed.toLowerCase().startsWith(openworkPrefix)) return trimmed;
  const withoutPrefix = trimmed.slice(openworkPrefix.length);
  return withoutPrefix.toLowerCase().startsWith("v") ? withoutPrefix : `v${withoutPrefix}`;
}

export function cloudWorkspaceUpdateAvailable(instance: DenCloudInstance | null): boolean {
  if (!instance?.latestVersion) return false;
  return instance.imageVersion === null || instance.imageVersion !== instance.latestVersion;
}

export function cloudWorkspaceStatusHasReadyContent(variant: CloudWorkspacePillVariant): boolean {
  return variant === "ready" || variant === "stale";
}

export function mapCloudWorkspaceMainContentDecision(input: {
  status: CloudWorkspacePillVariant;
  hasWorkspaces: boolean;
  gatewayMode: boolean;
}): CloudWorkspaceMainContentDecision {
  if (!input.gatewayMode) return "content";
  if (input.status === "failed") return "takeover";
  if (!cloudWorkspaceStatusHasReadyContent(input.status)) {
    return input.hasWorkspaces ? "content" : "takeover";
  }
  return input.hasWorkspaces ? "content" : "error";
}

export function shouldRefetchCloudWorkspaceOnReadyTransition(input: {
  previousStatus: CloudWorkspacePillVariant | null;
  nextStatus: CloudWorkspacePillVariant;
  gatewayMode: boolean;
}): boolean {
  if (!input.gatewayMode || input.previousStatus === null) return false;
  if (cloudWorkspaceStatusHasReadyContent(input.previousStatus)) return false;
  return cloudWorkspaceStatusHasReadyContent(input.nextStatus);
}

function versionDisplay(instance: DenCloudInstance | null) {
  return formatCloudWorkspaceVersion(instance?.imageVersion ?? null) ?? "Legacy workspace";
}

function latestDisplay(instance: DenCloudInstance | null) {
  return formatCloudWorkspaceVersion(instance?.latestVersion ?? null) ?? "Not available";
}

function connectedStatusLine(instance: DenCloudInstance, updateAvailable: boolean) {
  const version = formatCloudWorkspaceVersion(instance.imageVersion) ?? "legacy workspace";
  const latest = formatCloudWorkspaceVersion(instance.latestVersion);
  if (updateAvailable) return latest ? `Connected · ${version} -> ${latest}` : `Connected · ${version}`;
  return `Connected · ${version} (latest)`;
}

function baseLines(instance: DenCloudInstance | null, updateAvailable: boolean) {
  const version = versionDisplay(instance);
  const latest = latestDisplay(instance);
  const latestSuffix = !updateAvailable && instance?.latestVersion ? " (up to date)" : "";
  const instanceName = instance?.instanceName?.trim() ?? "";
  return {
    computerLine: instanceName ? `Computer: ${instanceName}` : null,
    versionLine: `Version: ${version}`,
    latestLine: `Latest: ${latest}${latestSuffix}`,
    backupsLine: "Backups on",
  };
}

export function mapCloudWorkspaceState(input: {
  instance: DenCloudInstance | null;
  updating: boolean;
  requestFailed?: boolean;
}): CloudWorkspaceViewModel {
  const updateAvailable = cloudWorkspaceUpdateAvailable(input.instance);
  const lines = baseLines(input.instance, updateAvailable);

  if (input.requestFailed || input.instance?.status === "failed") {
    return {
      variant: "failed",
      label: "Workspace needs attention",
      tone: "amber",
      statusLine: "Workspace needs attention",
      ...lines,
      updateAvailable,
      showUpdate: false,
      showRetry: true,
      pollMs: 5_000,
    };
  }

  if (input.updating) {
    return {
      variant: "updating",
      label: "Updating your workspace…",
      tone: "neutral",
      statusLine: "Updating your workspace…",
      ...lines,
      updateAvailable,
      showUpdate: false,
      showRetry: false,
      pollMs: 5_000,
    };
  }

  if (!input.instance || input.instance.status === "waking") {
    return {
      variant: "waking",
      label: "Waking your workspace…",
      tone: "neutral",
      statusLine: "Waking your workspace…",
      ...lines,
      updateAvailable,
      showUpdate: false,
      showRetry: false,
      pollMs: 5_000,
    };
  }

  if (input.instance.status === "provisioning") {
    return {
      variant: "provisioning",
      label: "Provisioning your workspace…",
      tone: "neutral",
      statusLine: "Provisioning your workspace…",
      ...lines,
      updateAvailable,
      showUpdate: false,
      showRetry: false,
      pollMs: 5_000,
    };
  }

  if (updateAvailable) {
    return {
      variant: "stale",
      label: "Update available",
      tone: "neutral",
      statusLine: connectedStatusLine(input.instance, true),
      ...lines,
      updateAvailable,
      showUpdate: true,
      showRetry: false,
      pollMs: 60_000,
    };
  }

  const version = formatCloudWorkspaceVersion(input.instance.imageVersion) ?? formatCloudWorkspaceVersion(input.instance.latestVersion);
  return {
    variant: "ready",
    label: version ? `Cloud · ${version}` : "Cloud",
    tone: "neutral",
    statusLine: connectedStatusLine(input.instance, false),
    ...lines,
    updateAvailable,
    showUpdate: false,
    showRetry: false,
    pollMs: 60_000,
  };
}
