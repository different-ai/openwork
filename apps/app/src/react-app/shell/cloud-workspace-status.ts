import type { DenCloudInstance, DenCloudStartupFailure } from "@/app/lib/den";

export function cloudWorkspaceFailureLogFields(failure: DenCloudStartupFailure) {
  return {
    failure_code: failure.code,
    failure_stage: failure.stage,
    failure_reference: failure.reference,
    failure_occurred_at: failure.occurredAt,
  };
}

export type CloudWorkspacePillVariant =
  | "ready"
  | "stale"
  | "waking"
  | "provisioning"
  | "updating"
  | "unavailable"
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

export type CloudWorkspaceBootStageState = "done" | "active" | "pending";

export type CloudWorkspaceBootStage = {
  id: string;
  label: string;
  state: CloudWorkspaceBootStageState;
};

/**
 * Boot progress is derived from the status we already poll rather than from a
 * timer, so the ladder can never claim more progress than we can prove. Each
 * variant tells us which checkpoint the sandbox is standing on: a provisioning
 * sandbox is still being reserved, while a waking or updating one demonstrably
 * exists already.
 */
const BOOT_STAGES: Partial<
  Record<CloudWorkspacePillVariant, { labels: readonly [string, string, string]; activeIndex: number }>
> = {
  provisioning: {
    labels: ["Reserving your computer", "Restoring your files", "Connecting the app"],
    activeIndex: 0,
  },
  waking: {
    labels: ["Reserving your computer", "Restoring your files", "Connecting the app"],
    activeIndex: 1,
  },
  updating: {
    labels: ["Saving your session", "Applying the latest image", "Reconnecting the app"],
    activeIndex: 1,
  },
};

export function cloudWorkspaceBootStages(variant: CloudWorkspacePillVariant): CloudWorkspaceBootStage[] {
  const stages = BOOT_STAGES[variant];
  if (!stages) return [];
  return stages.labels.map((label, index) => ({
    id: `${variant}-${index}`,
    label,
    state: index < stages.activeIndex ? "done" : index === stages.activeIndex ? "active" : "pending",
  }));
}

/** Past this point "usually under a minute" stops being true, so the copy and the actions change. */
export const CLOUD_WORKSPACE_SLOW_BOOT_MS = 45_000;

export function cloudWorkspaceBootIsSlow(elapsedMs: number): boolean {
  return elapsedMs >= CLOUD_WORKSPACE_SLOW_BOOT_MS;
}

export function formatCloudWorkspaceElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s elapsed`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s elapsed`;
}

export function cloudWorkspaceTakeoverCopy(input: {
  variant: CloudWorkspacePillVariant;
  slow: boolean;
}): { title: string; body: string } {
  if (input.variant === "failed") {
    return {
      title: "Workspace needs attention",
      body: "We couldn’t start the sandbox. Retry, or sign out and reconnect.",
    };
  }
  if (input.variant === "unavailable") {
    return {
      title: "Couldn’t check your workspace",
      body: "OpenWork Cloud didn’t answer. Your sandbox may still be running, so try checking again.",
    };
  }
  if (input.slow) {
    return {
      title: "Still working on it…",
      body: "This is taking longer than usual. You can keep waiting or check again.",
    };
  }
  if (input.variant === "provisioning") {
    return {
      title: "Starting your workspace…",
      body: "Usually under a minute. We’ll open it the moment it’s ready.",
    };
  }
  if (input.variant === "updating") {
    return {
      title: "Updating your workspace…",
      body: "We’re applying the latest OpenWork image. Your files and sessions come along.",
    };
  }
  return {
    title: "Waking your workspace…",
    body: "Your sandbox is coming back online. We’ll open it as soon as it’s ready.",
  };
}

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

// Stopped instances already recycle on wake; this only nudges running stale instances,
// skips while any client-visible run is active, and attempts once per target version so
// failed or already_current attempts cannot retry-loop.
export function shouldAutoUpdateCloudWorkspace(input: {
  gatewayMode: boolean;
  visible: boolean;
  status: "provisioning" | "waking" | "ready" | "failed" | null;
  updateAvailable: boolean;
  updating: boolean;
  requestFailed: boolean;
  hasActiveRun: boolean;
  latestVersion: string | null;
  lastAttemptedVersion: string | null;
}): boolean {
  return input.gatewayMode
    && input.visible
    && input.status === "ready"
    && input.updateAvailable
    && !input.updating
    && !input.requestFailed
    && !input.hasActiveRun
    && input.latestVersion !== null
    && input.latestVersion !== input.lastAttemptedVersion;
}

export function cloudWorkspaceStatusHasReadyContent(variant: CloudWorkspacePillVariant): boolean {
  return variant === "ready" || variant === "stale";
}

/**
 * Gateway boot is owned by the workspace takeover. Showing the generic overlay
 * at the same time stacks two wait indicators on first load.
 */
export function shouldSuppressBootOverlayForGateway(input: {
  gatewayMode: boolean;
  signedIn: boolean;
  variant: CloudWorkspacePillVariant;
}): boolean {
  return input.gatewayMode && input.signedIn && !cloudWorkspaceStatusHasReadyContent(input.variant);
}

export function shouldShowCloudWorkspaceStatusPill(input: {
  variant: CloudWorkspacePillVariant;
  hasInstance: boolean;
  requestFailed: boolean;
}): boolean {
  if (!input.hasInstance && !input.requestFailed) return false;
  return input.variant === "waking"
    || input.variant === "provisioning"
    || input.variant === "unavailable"
    || input.variant === "failed";
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

  if (input.requestFailed) {
    return {
      variant: "unavailable",
      label: "Couldn’t check workspace",
      tone: "amber",
      statusLine: "Couldn’t check workspace status",
      ...lines,
      updateAvailable,
      showUpdate: false,
      showRetry: true,
      pollMs: 5_000,
    };
  }

  if (input.instance?.status === "failed") {
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
