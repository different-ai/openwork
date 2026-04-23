/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  publishSkillsSetBundleFromWorkspace,
  publishWorkspaceProfileBundleFromWorkspace,
  saveWorkspaceProfileBundleToTeam,
} from "../../../app/bundles/publish";
import { buildDenAuthUrl, readDenSettings } from "../../../app/lib/den";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
  type OpenworkWorkspaceExportSensitiveMode,
  type OpenworkWorkspaceExportWarning,
} from "../../../app/lib/openwork-server";
import type {
  EngineInfo,
  OpenworkServerInfo,
  WorkspaceInfo,
} from "../../../app/lib/desktop";
import type { OpenworkServerSettings } from "../../../app/lib/openwork-server";
import { t } from "../../../i18n";
import { isDesktopRuntime, normalizeDirectoryPath } from "../../../app/utils";

export type ShareWorkspaceState = ReturnType<typeof useShareWorkspaceState>;

type UseShareWorkspaceStateOptions = {
  workspaces: WorkspaceInfo[];
  openworkServerHostInfo: OpenworkServerInfo | null;
  openworkServerSettings: OpenworkServerSettings;
  engineInfo: EngineInfo | null;
  exportWorkspaceBusy: boolean;
  openLink: (url: string) => void;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
};

export function useShareWorkspaceState(options: UseShareWorkspaceStateOptions) {
  type ShareWorkspaceProfileSensitiveMode = Exclude<
    OpenworkWorkspaceExportSensitiveMode,
    "auto"
  >;

  const [shareWorkspaceId, setShareWorkspaceId] = useState<string | null>(null);
  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] = useState<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = useState(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = useState<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] = useState<string | null>(null);
  const [shareWorkspaceProfileSensitiveWarnings, setShareWorkspaceProfileSensitiveWarnings] = useState<OpenworkWorkspaceExportWarning[] | null>(null);
  const [shareWorkspaceProfileSensitiveMode, setShareWorkspaceProfileSensitiveMode] = useState<ShareWorkspaceProfileSensitiveMode | null>(null);
  const [shareWorkspaceProfileTeamBusy, setShareWorkspaceProfileTeamBusy] = useState(false);
  const [shareWorkspaceProfileTeamError, setShareWorkspaceProfileTeamError] = useState<string | null>(null);
  const [shareWorkspaceProfileTeamSuccess, setShareWorkspaceProfileTeamSuccess] = useState<string | null>(null);
  const [shareCloudSettingsVersion, setShareCloudSettingsVersion] = useState(0);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = useState(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = useState<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] = useState<string | null>(null);

  const openShareWorkspace = useCallback((workspaceId: string) => {
    setShareWorkspaceId(workspaceId);
  }, []);

  const closeShareWorkspace = useCallback(() => {
    setShareWorkspaceId(null);
  }, []);

  const shareWorkspace = useMemo(() => {
    const id = shareWorkspaceId;
    if (!id) return null;
    return options.workspaces.find((workspace) => workspace.id === id) ?? null;
  }, [options.workspaces, shareWorkspaceId]);

  const shareWorkspaceName = useMemo(() => {
    return shareWorkspace ? options.workspaceLabel(shareWorkspace) : "";
  }, [options, shareWorkspace]);

  const shareWorkspaceDetail = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return "";
    if (workspace.workspaceType === "remote") {
      if (workspace.remoteType === "openwork") {
        const hostUrl = workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
        const mounted = buildOpenworkWorkspaceBaseUrl(
          hostUrl,
          workspace.openworkWorkspaceId,
        );
        return mounted || hostUrl;
      }
      return workspace.baseUrl?.trim() || "";
    }
    return workspace.path?.trim() || "";
  }, [shareWorkspace]);

  useEffect(() => {
    setShareWorkspaceProfileBusy(false);
    setShareWorkspaceProfileUrl(null);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileSensitiveWarnings(null);
    setShareWorkspaceProfileSensitiveMode(null);
    setShareWorkspaceProfileTeamBusy(false);
    setShareWorkspaceProfileTeamError(null);
    setShareWorkspaceProfileTeamSuccess(null);
    setShareSkillsSetBusy(false);
    setShareSkillsSetUrl(null);
    setShareSkillsSetError(null);
  }, [shareWorkspaceId]);

  useEffect(() => {
    const workspace = shareWorkspace;
    const baseUrl = options.openworkServerHostInfo?.baseUrl?.trim() ?? "";
    const token =
      options.openworkServerHostInfo?.ownerToken?.trim() ||
      options.openworkServerHostInfo?.clientToken?.trim() ||
      "";
    const workspacePath = workspace?.workspaceType === "local" ? (workspace.path?.trim() ?? "") : "";

    if (
      !workspace ||
      workspace.workspaceType !== "local" ||
      !workspacePath ||
      !baseUrl ||
      !token
    ) {
      setShareLocalOpenworkWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalOpenworkWorkspaceId(null);

    void (async () => {
      try {
        const client = createOpenworkServerClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspacePath);
        const match = items.find(
          (entry) => normalizeDirectoryPath(entry.path) === targetPath,
        );
        setShareLocalOpenworkWorkspaceId(match?.id ?? null);
      } catch {
        if (!cancelled) setShareLocalOpenworkWorkspaceId(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [options.openworkServerHostInfo, shareWorkspace]);

  const shareFields = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) {
      return [] as Array<{
        label: string;
        value: string;
        secret?: boolean;
        placeholder?: string;
        hint?: string;
      }>;
    }

    if (workspace.workspaceType !== "remote") {
      if (options.openworkServerHostInfo?.remoteAccessEnabled !== true) {
        return [];
      }
      const hostUrl =
        options.openworkServerHostInfo?.connectUrl?.trim() ||
        options.openworkServerHostInfo?.lanUrl?.trim() ||
        options.openworkServerHostInfo?.mdnsUrl?.trim() ||
        options.openworkServerHostInfo?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenworkWorkspaceId
        ? buildOpenworkWorkspaceBaseUrl(hostUrl, shareLocalOpenworkWorkspaceId)
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = options.openworkServerHostInfo?.ownerToken?.trim() || "";
      const collaboratorToken = options.openworkServerHostInfo?.clientToken?.trim() || "";
      return [
        {
          label: t("session.share_worker_url"),
          value: url,
          placeholder: !isDesktopRuntime()
            ? t("session.share_desktop_app_required")
            : t("session.share_starting_server"),
          hint: mountedUrl
            ? t("session.share_worker_url_phones_hint")
            : hostUrl
              ? t("session.share_worker_url_resolving_hint")
              : undefined,
        },
        {
          label: t("session.share_password"),
          value: ownerToken,
          secret: true,
          placeholder: isDesktopRuntime() ? "-" : t("session.share_desktop_app_required"),
          hint: mountedUrl
            ? t("session.share_worker_url_phones_hint")
            : t("session.share_owner_permission_hint"),
        },
        {
          label: t("session.share_collaborator_label"),
          value: collaboratorToken,
          secret: true,
          placeholder: isDesktopRuntime() ? "-" : t("session.share_desktop_app_required"),
          hint: mountedUrl
            ? t("session.share_collaborator_hint")
            : t("session.share_collaborator_host_hint"),
        },
      ];
    }

    if (workspace.remoteType === "openwork") {
      const hostUrl = workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
      const url =
        buildOpenworkWorkspaceBaseUrl(hostUrl, workspace.openworkWorkspaceId) ||
        hostUrl;
      const token =
        workspace.openworkToken?.trim() ||
        options.openworkServerSettings.token?.trim() ||
        "";
      return [
        {
          label: t("session.share_worker_url"),
          value: url,
        },
        {
          label: t("session.share_password"),
          value: token,
          secret: true,
          placeholder: token ? undefined : t("session.share_set_token_hint"),
          hint: t("session.share_connected_with_hint"),
        },
      ];
    }

    const baseUrl = workspace.baseUrl?.trim() || workspace.path?.trim() || "";
    const directory = workspace.directory?.trim() || "";
    return [
      {
        label: t("session.share_opencode_base_url"),
        value: baseUrl,
      },
      {
        label: t("common.path"),
        value: directory,
        placeholder: t("common.default_parens"),
      },
    ];
  }, [
    options.openworkServerHostInfo,
    options.openworkServerSettings,
    shareLocalOpenworkWorkspaceId,
    shareWorkspace,
  ]);

  const shareNote = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return null;
    if (workspace.workspaceType === "local" && options.engineInfo?.runtime === "direct") {
      return t("session.share_note_direct_runtime");
    }
    return null;
  }, [options.engineInfo, shareWorkspace]);

  const shareServiceDisabledReason = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return t("session.share_select_workspace");
    if (workspace.workspaceType === "remote" && workspace.remoteType !== "openwork") {
      return t("session.share_openwork_workers_only");
    }
    if (workspace.workspaceType !== "remote") {
      const baseUrl = options.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        options.openworkServerHostInfo?.ownerToken?.trim() ||
        options.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return t("session.share_local_host_not_ready");
      }
    } else {
      const hostUrl = workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
      const token =
        workspace.openworkToken?.trim() ||
        options.openworkServerSettings.token?.trim() ||
        "";
      if (!hostUrl) return t("session.share_missing_host_url");
      if (!token) return t("session.share_missing_token");
    }
    return null;
  }, [options.openworkServerHostInfo, options.openworkServerSettings, shareWorkspace]);

  const shareCloudSettings = useMemo(() => {
    void shareWorkspaceId;
    void shareCloudSettingsVersion;
    return readDenSettings();
  }, [shareCloudSettingsVersion, shareWorkspaceId]);

  useEffect(() => {
    const handleCloudSessionUpdate = () => {
      setShareCloudSettingsVersion((value) => value + 1);
    };
    window.addEventListener("openwork-den-session-updated", handleCloudSessionUpdate);
    return () => {
      window.removeEventListener("openwork-den-session-updated", handleCloudSessionUpdate);
    };
  }, []);

  const shareWorkspaceProfileTeamOrgName = useMemo(() => {
    const orgName = shareCloudSettings.activeOrgName?.trim();
    if (orgName) return orgName;
    return t("session.share_active_cloud_org");
  }, [shareCloudSettings]);

  const shareWorkspaceProfileToTeamNeedsSignIn = useMemo(
    () => !shareCloudSettings.authToken?.trim(),
    [shareCloudSettings],
  );

  const shareWorkspaceProfileTeamDisabledReason = useMemo(() => {
    const exportReason = shareServiceDisabledReason;
    if (exportReason) return exportReason;
    if (shareWorkspaceProfileToTeamNeedsSignIn) return null;
    if (!shareCloudSettings.activeOrgId?.trim() && !shareCloudSettings.activeOrgSlug?.trim()) {
      return t("session.share_choose_org");
    }
    return null;
  }, [shareCloudSettings, shareServiceDisabledReason, shareWorkspaceProfileToTeamNeedsSignIn]);

  const startShareWorkspaceProfileToTeamSignIn = useCallback(() => {
    const settings = readDenSettings();
    options.openLink(buildDenAuthUrl(settings.baseUrl, "sign-in"));
  }, [options]);

  const resolveShareExportContext = useCallback(async (): Promise<{
    client: ReturnType<typeof createOpenworkServerClient>;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const workspace = shareWorkspace;
    if (!workspace) {
      throw new Error(t("session.share_select_workspace"));
    }

    if (workspace.workspaceType !== "remote") {
      const baseUrl = options.openworkServerHostInfo?.baseUrl?.trim() ?? "";
      const token =
        options.openworkServerHostInfo?.ownerToken?.trim() ||
        options.openworkServerHostInfo?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        throw new Error(t("session.share_local_host_not_ready"));
      }
      const client = createOpenworkServerClient({ baseUrl, token });

      let workspaceId = shareLocalOpenworkWorkspaceId?.trim() ?? "";
      if (!workspaceId) {
        const response = await client.listWorkspaces();
        const items = Array.isArray(response.items) ? response.items : [];
        const targetPath = normalizeDirectoryPath(workspace.path?.trim() ?? "");
        const match = items.find(
          (entry) => normalizeDirectoryPath(entry.path) === targetPath,
        );
        workspaceId = (match?.id ?? "").trim();
        setShareLocalOpenworkWorkspaceId(workspaceId || null);
      }

      if (!workspaceId) {
        throw new Error(t("session.share_resolve_local_workspace_failed"));
      }

      return { client, workspaceId, workspace };
    }

    if (workspace.remoteType !== "openwork") {
      throw new Error(t("session.share_openwork_workers_only"));
    }

    const hostUrl = workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
    const token =
      workspace.openworkToken?.trim() ||
      options.openworkServerSettings.token?.trim() ||
      "";
    if (!hostUrl || !token) {
      throw new Error(t("session.share_host_url_and_token_required"));
    }

    const client = createOpenworkServerClient({ baseUrl: hostUrl, token });
    let workspaceId =
      workspace.openworkWorkspaceId?.trim() ||
      parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
      parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
      "";

    if (!workspaceId) {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      const directoryHint = normalizeDirectoryPath(
        workspace.directory?.trim() ?? workspace.path?.trim() ?? "",
      );
      const match = directoryHint
        ? items.find((entry) => {
            const entryPath = normalizeDirectoryPath(
              (
                entry.opencode?.directory ??
                entry.directory ??
                entry.path ??
                ""
              ).trim(),
            );
            return Boolean(entryPath && entryPath === directoryHint);
          })
        : ((response.activeId
            ? items.find((entry) => entry.id === response.activeId)
            : null) ?? items[0]);
      workspaceId = (match?.id ?? "").trim();
    }

    if (!workspaceId) {
      throw new Error(t("session.share_resolve_remote_workspace_failed"));
    }

    return { client, workspaceId, workspace };
  }, [
    options.openworkServerHostInfo,
    options.openworkServerSettings,
    options.workspaceLabel,
    shareLocalOpenworkWorkspaceId,
    shareWorkspace,
  ]);

  const publishWorkspaceProfileLink = useCallback(async () => {
    if (shareWorkspaceProfileBusy) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const result = await publishWorkspaceProfileBundleFromWorkspace({
        client,
        workspaceId,
        workspaceName: options.workspaceLabel(workspace),
        sensitiveMode: shareWorkspaceProfileSensitiveMode,
      });

      setShareWorkspaceProfileUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      const warnings = readWorkspaceExportWarnings(error);
      if (warnings) {
        setShareWorkspaceProfileSensitiveWarnings(warnings);
        setShareWorkspaceProfileError(null);
        return;
      }
      setShareWorkspaceProfileError(
        error instanceof Error ? error.message : t("session.share_publish_workspace_failed"),
      );
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  }, [
    options,
    resolveShareExportContext,
    shareWorkspaceProfileBusy,
    shareWorkspaceProfileSensitiveMode,
  ]);

  const shareWorkspaceProfileToTeam = useCallback(async (templateName: string) => {
    if (shareWorkspaceProfileTeamBusy) return;
    setShareWorkspaceProfileTeamBusy(true);
    setShareWorkspaceProfileTeamError(null);
    setShareWorkspaceProfileTeamSuccess(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const { created, orgName } = await saveWorkspaceProfileBundleToTeam({
        client,
        workspaceId,
        workspaceName: options.workspaceLabel(workspace),
        requestedName: templateName,
        sensitiveMode: shareWorkspaceProfileSensitiveMode,
      });

      setShareWorkspaceProfileTeamSuccess(
        t("session.share_saved_to_org", undefined, {
          name: created.name,
          org: orgName || t("session.share_team_fallback_name"),
        }),
      );
    } catch (error) {
      const warnings = readWorkspaceExportWarnings(error);
      if (warnings) {
        setShareWorkspaceProfileSensitiveWarnings(warnings);
        setShareWorkspaceProfileTeamError(null);
        return;
      }
      setShareWorkspaceProfileTeamError(
        error instanceof Error ? error.message : t("session.share_save_team_template_failed"),
      );
    } finally {
      setShareWorkspaceProfileTeamBusy(false);
    }
  }, [
    options,
    resolveShareExportContext,
    shareWorkspaceProfileSensitiveMode,
    shareWorkspaceProfileTeamBusy,
  ]);

  const publishSkillsSetLink = useCallback(async () => {
    if (shareSkillsSetBusy) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const result = await publishSkillsSetBundleFromWorkspace({
        client,
        workspaceId,
        workspaceName: options.workspaceLabel(workspace),
      });

      setShareSkillsSetUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
      } catch {
        // ignore
      }
    } catch (error) {
      setShareSkillsSetError(
        error instanceof Error ? error.message : t("session.share_publish_skills_failed"),
      );
    } finally {
      setShareSkillsSetBusy(false);
    }
  }, [options, resolveShareExportContext, shareSkillsSetBusy]);

  const exportDisabledReason = useMemo(() => {
    const workspace = shareWorkspace;
    if (!workspace) return t("session.export_desktop_only_local");
    if (workspace.workspaceType === "remote") {
      return t("session.export_local_only");
    }
    if (!isDesktopRuntime()) return t("session.export_desktop_only");
    if (options.exportWorkspaceBusy) return t("session.export_already_running");
    return null;
  }, [options.exportWorkspaceBusy, shareWorkspace]);

  return {
    shareWorkspaceId,
    shareWorkspaceOpen: Boolean(shareWorkspaceId),
    openShareWorkspace,
    closeShareWorkspace,
    shareWorkspace,
    shareWorkspaceName,
    shareWorkspaceDetail,
    shareFields,
    shareNote,
    shareServiceDisabledReason,
    shareWorkspaceProfileBusy,
    shareWorkspaceProfileUrl,
    shareWorkspaceProfileError,
    shareWorkspaceProfileSensitiveWarnings,
    shareWorkspaceProfileSensitiveMode,
    setShareWorkspaceProfileSensitiveMode,
    publishWorkspaceProfileLink,
    shareWorkspaceProfileTeamBusy,
    shareWorkspaceProfileTeamError,
    shareWorkspaceProfileTeamSuccess,
    shareWorkspaceProfileTeamOrgName,
    shareWorkspaceProfileToTeamNeedsSignIn,
    shareWorkspaceProfileTeamDisabledReason,
    shareWorkspaceProfileToTeam,
    startShareWorkspaceProfileToTeamSignIn,
    shareSkillsSetBusy,
    shareSkillsSetUrl,
    shareSkillsSetError,
    publishSkillsSetLink,
    exportDisabledReason,
  };
}

function readWorkspaceExportWarnings(
  error: unknown,
): OpenworkWorkspaceExportWarning[] | null {
  if (!(error instanceof OpenworkServerError) || error.code !== "workspace_export_requires_decision") {
    return null;
  }
  const warnings = Array.isArray((error.details as { warnings?: unknown } | undefined)?.warnings)
    ? (error.details as { warnings: unknown[] }).warnings
    : [];
  const normalized = warnings
    .map((warning) => {
      if (!warning || typeof warning !== "object") return null;
      const record = warning as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const label = typeof record.label === "string" ? record.label.trim() : "";
      const detail = typeof record.detail === "string" ? record.detail.trim() : "";
      if (!id || !label || !detail) return null;
      return { id, label, detail } satisfies OpenworkWorkspaceExportWarning;
    })
    .filter((warning): warning is OpenworkWorkspaceExportWarning => Boolean(warning));
  return normalized.length ? normalized : null;
}
