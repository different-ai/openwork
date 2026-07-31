import type {
  AppManifest,
  AppAuditEntry,
  AppPermission,
  InstalledAppRecord,
  PermissionDelta,
} from "@openwork/app-contract";

// Typed client for the OpenWork Apps host routes.
//
// Every method mirrors one server route. Nothing here decides anything: the
// server owns validation, verification, and authorisation, and this exists so
// the UI cannot accidentally send a shape the server would have to guess about.

export type AppPermissionSummary = {
  permission: AppPermission;
  risk: "critical" | "high" | "moderate" | "low";
  label: string;
  reason: string;
  detail: string | null;
};

export type AppEnvironmentRequirement = {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
};

export type AppPreview = {
  candidateId: string;
  expiresAt: number;
  manifest: AppManifest;
  source: {
    repository: string;
    releaseTag: string;
    commit: string;
    assetName: string;
    publishedAt: string | null;
    prerelease: boolean;
  };
  archiveDigest: string;
  permissions: AppPermissionSummary[];
  environment: AppEnvironmentRequirement[];
  contributions: AppManifest["contributions"];
  compatible: boolean;
  warnings: string[];
  installed: { version: string; delta: PermissionDelta } | null;
};

/**
 * One thing an installed app needs from the user, and whether it has it.
 *
 * `description` and `docsUrl` are the app author's own words. The host knows a
 * key is missing; only the author knows what it unlocks, so a setup state that
 * only names the key is a state the user cannot act on.
 */
export type AppRequirement = {
  key: string;
  label: string;
  required: boolean;
  configured: boolean;
  description?: string;
  docsUrl?: string;
};

export type AppsTransport = {
  request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
};

export function createAppsClient(transport: AppsTransport) {
  return {
    list: () =>
      transport.request<{
        items: InstalledAppRecord[];
        requirements: Record<string, AppRequirement[] | undefined>;
        rejected: string[];
      }>("/apps"),

    get: (appId: string) =>
      transport.request<{ record: InstalledAppRecord; manifest: AppManifest | null }>(
        `/apps/${encodeURIComponent(appId)}`,
      ),

    /** Resolve and verify a repository without executing any of its code. */
    preview: (repositoryUrl: string, tag?: string) =>
      transport.request<AppPreview>("/apps/preview", {
        method: "POST",
        body: tag === undefined ? { repositoryUrl } : { repositoryUrl, tag },
      }),

    /**
     * Install a previewed candidate.
     *
     * `approvedPermissions` must be exactly what the review screen displayed.
     * The server compares it against the candidate and refuses a mismatch, so
     * this is a confirmation rather than a second chance to choose.
     */
    install: (candidateId: string, approvedPermissions: AppPermission[]) =>
      transport.request<{ record: InstalledAppRecord }>("/apps/install", {
        method: "POST",
        body: { candidateId, approvedPermissions },
      }),

    enable: (appId: string) =>
      transport.request<{ record: InstalledAppRecord }>(
        `/apps/${encodeURIComponent(appId)}/enable`,
        { method: "POST" },
      ),

    disable: (appId: string) =>
      transport.request<{ record: InstalledAppRecord }>(
        `/apps/${encodeURIComponent(appId)}/disable`,
        { method: "POST" },
      ),

    refreshSetup: (appId: string) =>
      transport.request<{ record: InstalledAppRecord }>(
        `/apps/${encodeURIComponent(appId)}/setup/refresh`,
        { method: "POST" },
      ),

    revokePermission: (appId: string, permission: string) =>
      transport.request<{ record: InstalledAppRecord }>(
        `/apps/${encodeURIComponent(appId)}/permissions/revoke`,
        { method: "POST", body: { permission } },
      ),

    update: (
      appId: string,
      candidateId: string,
      approvedPermissions: AppPermission[],
      permissionsReviewed = false,
    ) =>
      transport.request<{ record: InstalledAppRecord; applied: boolean; delta: PermissionDelta }>(
        `/apps/${encodeURIComponent(appId)}/update`,
        { method: "POST", body: { candidateId, approvedPermissions, permissionsReviewed } },
      ),

    approvePendingUpdate: (appId: string) =>
      transport.request<{ record: InstalledAppRecord }>(
        `/apps/${encodeURIComponent(appId)}/update/approve`,
        { method: "POST" },
      ),

    rollback: (appId: string) =>
      transport.request<{ record: InstalledAppRecord }>(
        `/apps/${encodeURIComponent(appId)}/rollback`,
        { method: "POST" },
      ),

    /**
     * `deleteData` is required, not defaulted.
     *
     * Defaulting to deletion would destroy data a user may want on reinstall;
     * defaulting to retention would leave data behind after someone asked for
     * the app to be gone. The choice belongs to the user, so it is explicit all
     * the way to the server.
     */
    uninstall: (appId: string, deleteData: boolean) =>
      transport.request<{ removed: boolean }>(
        `/apps/${encodeURIComponent(appId)}?deleteData=${deleteData ? "true" : "false"}`,
        { method: "DELETE" },
      ),

    audit: (appId: string, limit = 100) =>
      transport.request<{ items: AppAuditEntry[] }>(
        `/apps/${encodeURIComponent(appId)}/audit?limit=${limit}`,
      ),
  };
}

export type AppsClient = ReturnType<typeof createAppsClient>;

/** Where an app currently sits, phrased the way the UI needs to show it. */
export type AppLifecyclePhase =
  | "needs_setup"
  | "disabled"
  | "enabled"
  | "update_pending_review"
  | "quarantined"
  | "incompatible"
  | "corrupt";

export function lifecyclePhase(record: InstalledAppRecord): AppLifecyclePhase {
  if (record.installation === "corrupt") return "corrupt";
  if (record.installation === "quarantined") return "quarantined";
  if (record.installation === "update_pending_review") return "update_pending_review";
  if (record.compatibility !== "compatible") return "incompatible";
  if (record.setup !== "ready") return "needs_setup";
  return record.enablement === "enabled" ? "enabled" : "disabled";
}

/** One line the user can act on, for each phase. */
export function lifecycleGuidance(record: InstalledAppRecord): string {
  switch (lifecyclePhase(record)) {
    case "corrupt":
      return "This app's files failed verification. Repair it to reinstall the verified package.";
    case "quarantined":
      return "This app crashed repeatedly and was stopped. Repair it to try again.";
    case "update_pending_review":
      return "An update is ready but asks for more than you approved. Review what changed.";
    case "incompatible":
      return "This app does not run on this version of OpenWork.";
    case "needs_setup":
      return "Add the settings this app needs, then turn it on.";
    case "disabled":
      return "Installed and ready. Turn it on when you want it running.";
    case "enabled":
      return "Running.";
  }
}
