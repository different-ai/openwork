import type { DenCloudInstance, DenCloudInstanceUpdateDeferral, DenCloudStartupFailure } from "@/app/lib/den";

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
  | "access-required"
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
  pollMs: number | null;
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
  if (input.variant === "access-required") {
    return {
      title: "OpenWork Web needs an active plan",
      body: "Your organization does not have an active OpenWork Web subscription or complimentary access. Get OpenWork Web in Den to start your cloud workspace.",
    };
  }
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

/** A tab hidden this long counts as the person having stepped away. */
export const CLOUD_AUTO_UPDATE_HIDDEN_MS = 5 * 60_000;
/** A visible tab with no pointer or keyboard input this long counts the same. */
export const CLOUD_AUTO_UPDATE_INPUT_IDLE_MS = 10 * 60_000;
/** After the server defers an update, wait at least this long before asking again. */
export const CLOUD_AUTO_UPDATE_DEFERRED_RETRY_MS = 5 * 60_000;

/**
 * Whether the person is away from this tab: hidden long enough, or visible
 * but untouched long enough. An update restarts the workspace, so it must
 * never start the moment someone is reading or typing.
 */
export function isUserAway(input: {
  hiddenSinceMs: number | null;
  lastInputAtMs: number;
  nowMs: number;
  hiddenMs?: number;
  idleMs?: number;
}): boolean {
  const hiddenMs = input.hiddenMs ?? CLOUD_AUTO_UPDATE_HIDDEN_MS;
  const idleMs = input.idleMs ?? CLOUD_AUTO_UPDATE_INPUT_IDLE_MS;
  if (input.hiddenSinceMs !== null && input.nowMs - input.hiddenSinceMs >= hiddenMs) return true;
  return input.nowMs - input.lastInputAtMs >= idleMs;
}

// Stopped instances already recycle on wake; this only nudges running stale instances.
// It waits until the person is away and no client-visible run is active, honors the
// retry window after a server-side deferral, and otherwise attempts once per target
// version so failed or already_current attempts cannot retry-loop. The server makes
// the authoritative busy check for other tabs, devices, remote sessions, and Automations.
export function shouldAutoUpdateCloudWorkspace(input: {
  gatewayMode: boolean;
  visible: boolean;
  away: boolean;
  status: "provisioning" | "waking" | "ready" | "failed" | null;
  updateAvailable: boolean;
  updating: boolean;
  requestFailed: boolean;
  hasActiveRun: boolean;
  latestVersion: string | null;
  lastAttemptedVersion: string | null;
  nowMs?: number;
  retryNotBeforeMs?: number | null;
}): boolean {
  return input.gatewayMode
    && input.visible
    && input.away
    && input.status === "ready"
    && input.updateAvailable
    && !input.updating
    && !input.requestFailed
    && !input.hasActiveRun
    && input.latestVersion !== null
    && input.latestVersion !== input.lastAttemptedVersion
    && (input.retryNotBeforeMs == null || (input.nowMs ?? Date.now()) >= input.retryNotBeforeMs);
}

export function cloudWorkspaceUpdateDeferredLine(deferral: DenCloudInstanceUpdateDeferral): string {
  return deferral === "busy"
    ? "Update ready · it applies when your current work finishes"
    : "Update ready · we couldn’t confirm your workspace is idle yet and will try again";
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
  if (input.status === "failed" || input.status === "access-required") return "takeover";
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
  accessRequired: boolean;
  requestFailed?: boolean;
  updateDeferred?: DenCloudInstanceUpdateDeferral | null;
}): CloudWorkspaceViewModel {
  const updateAvailable = cloudWorkspaceUpdateAvailable(input.instance);
  const lines = baseLines(input.instance, updateAvailable);

  if (input.accessRequired) {
    return {
      variant: "access-required",
      label: "OpenWork Web plan required",
      tone: "amber",
      statusLine: "OpenWork Web plan required",
      ...lines,
      updateAvailable,
      showUpdate: false,
      showRetry: true,
      pollMs: null,
    };
  }

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
      statusLine: input.updateDeferred
        ? cloudWorkspaceUpdateDeferredLine(input.updateDeferred)
        : connectedStatusLine(input.instance, true),
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
