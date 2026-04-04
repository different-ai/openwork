import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  type Accessor,
} from "solid-js";

import { t } from "../../i18n";

import {
  publishSkillsSetBundleFromWorkspace,
  publishWorkspaceProfileBundleFromWorkspace,
  saveWorkspaceProfileBundleToTeam,
} from "../bundles/publish";
import { buildDenAuthUrl, readDenSettings } from "../lib/den";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  OpenworkServerError,
  parseOpenworkWorkspaceIdFromUrl,
  type OpenworkWorkspaceExportSensitiveMode,
  type OpenworkWorkspaceExportWarning,
} from "../lib/openwork-server";
import type {
  EngineInfo,
  OpenworkServerInfo,
  WorkspaceInfo,
} from "../lib/tauri";
import type { OpenworkServerSettings } from "../lib/openwork-server";
import { isTauriRuntime, normalizeDirectoryPath } from "../utils";

export type ShareWorkspaceState = ReturnType<typeof createShareWorkspaceState>;

type ShareWorkspaceStateOptions = {
  workspaces: Accessor<WorkspaceInfo[]>;
  openworkServerHostInfo: Accessor<OpenworkServerInfo | null>;
  openworkServerSettings: Accessor<OpenworkServerSettings>;
  engineInfo: Accessor<EngineInfo | null>;
  exportWorkspaceBusy: Accessor<boolean>;
  openLink: (url: string) => void;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
};

export function createShareWorkspaceState(options: ShareWorkspaceStateOptions) {
  type ShareWorkspaceProfileSensitiveMode = Exclude<OpenworkWorkspaceExportSensitiveMode, "auto">;

  const [shareWorkspaceId, setShareWorkspaceId] = createSignal<string | null>(null);
  const [shareLocalOpenworkWorkspaceId, setShareLocalOpenworkWorkspaceId] =
    createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] =
    createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] =
    createSignal<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] =
    createSignal<string | null>(null);
  const [shareWorkspaceProfileSensitiveWarnings, setShareWorkspaceProfileSensitiveWarnings] =
    createSignal<OpenworkWorkspaceExportWarning[] | null>(null);
  const [shareWorkspaceProfileSensitiveMode, setShareWorkspaceProfileSensitiveMode] =
    createSignal<ShareWorkspaceProfileSensitiveMode | null>(null);
  const [shareWorkspaceProfileTeamBusy, setShareWorkspaceProfileTeamBusy] =
    createSignal(false);
  const [shareWorkspaceProfileTeamError, setShareWorkspaceProfileTeamError] =
    createSignal<string | null>(null);
  const [shareWorkspaceProfileTeamSuccess, setShareWorkspaceProfileTeamSuccess] =
    createSignal<string | null>(null);
  const [shareCloudSettingsVersion, setShareCloudSettingsVersion] =
    createSignal(0);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] =
    createSignal<string | null>(null);

  const openShareWorkspace = (workspaceId: string) => setShareWorkspaceId(workspaceId);
  const closeShareWorkspace = () => setShareWorkspaceId(null);

  const shareWorkspace = createMemo(() => {
    const id = shareWorkspaceId();
    if (!id) return null;
    return options.workspaces().find((workspace) => workspace.id === id) ?? null;
  });

  const shareWorkspaceName = createMemo(() => {
    const workspace = shareWorkspace();
    return workspace ? options.workspaceLabel(workspace) : "";
  });

  const shareWorkspaceDetail = createMemo(() => {
    const workspace = shareWorkspace();
    if (!workspace) return "";
    if (workspace.workspaceType === "remote") {
      if (workspace.remoteType === "openwork") {
        const hostUrl =
          workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
        const mounted = buildOpenworkWorkspaceBaseUrl(
          hostUrl,
          workspace.openworkWorkspaceId,
        );
        return mounted || hostUrl;
      }
      return workspace.baseUrl?.trim() || "";
    }
    return workspace.path?.trim() || "";
  });

  createEffect(
    on(shareWorkspaceId, () => {
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
    }),
  );

  createEffect(() => {
    const workspace = shareWorkspace();
    const baseUrl = options.openworkServerHostInfo()?.baseUrl?.trim() ?? "";
    const token =
      options.openworkServerHostInfo()?.ownerToken?.trim() ||
      options.openworkServerHostInfo()?.clientToken?.trim() ||
      "";
    const workspacePath =
      workspace?.workspaceType === "local" ? (workspace.path?.trim() ?? "") : "";

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

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() => {
    const workspace = shareWorkspace();
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
      if (options.openworkServerHostInfo()?.remoteAccessEnabled !== true) {
        return [];
      }
      const hostUrl =
        options.openworkServerHostInfo()?.connectUrl?.trim() ||
        options.openworkServerHostInfo()?.lanUrl?.trim() ||
        options.openworkServerHostInfo()?.mdnsUrl?.trim() ||
        options.openworkServerHostInfo()?.baseUrl?.trim() ||
        "";
      const mountedUrl = shareLocalOpenworkWorkspaceId()
        ? buildOpenworkWorkspaceBaseUrl(hostUrl, shareLocalOpenworkWorkspaceId())
        : null;
      const url = mountedUrl || hostUrl;
      const ownerToken = options.openworkServerHostInfo()?.ownerToken?.trim() || "";
      const collaboratorToken =
        options.openworkServerHostInfo()?.clientToken?.trim() || "";
      return [
        {
          label: t("session.share_worker_url"),
          value: url,
          placeholder: !isTauriRuntime()
            ? t("session.share_desktop_required")
            : t("session.share_starting_server"),
          hint: mountedUrl
            ? t("session.share_url_worker_hint")
            : hostUrl
              ? t("session.share_url_resolving_hint")
              : undefined,
        },
        {
          label: t("session.share_password"),
          value: ownerToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : t("session.share_desktop_required"),
          hint: mountedUrl
            ? t("session.share_url_worker_hint")
            : t("session.share_password_owner_hint"),
        },
        {
          label: t("session.share_collaborator_token"),
          value: collaboratorToken,
          secret: true,
          placeholder: isTauriRuntime() ? "-" : t("session.share_desktop_required"),
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
        options.openworkServerSettings().token?.trim() ||
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
  });

  const shareNote = createMemo(() => {
    const workspace = shareWorkspace();
    if (!workspace) return null;
    if (
      workspace.workspaceType === "local" &&
      options.engineInfo()?.runtime === "direct"
    ) {
      return t("session.share_note_direct_runtime");
    }
    return null;
  });

  const shareServiceDisabledReason = createMemo(() => {
    const workspace = shareWorkspace();
    if (!workspace) return t("session.share_select_workspace");
    if (workspace.workspaceType === "remote" && workspace.remoteType !== "openwork") {
      return t("session.share_openwork_workers_only");
    }
    if (workspace.workspaceType !== "remote") {
      const baseUrl = options.openworkServerHostInfo()?.baseUrl?.trim() ?? "";
      const token =
        options.openworkServerHostInfo()?.ownerToken?.trim() ||
        options.openworkServerHostInfo()?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        return t("session.share_local_host_not_ready");
      }
    } else {
      const hostUrl = workspace.openworkHostUrl?.trim() || workspace.baseUrl?.trim() || "";
      const token =
        workspace.openworkToken?.trim() ||
        options.openworkServerSettings().token?.trim() ||
        "";
      if (!hostUrl) return t("session.share_missing_host_url");
      if (!token) return t("session.share_missing_token");
    }
    return null;
  });

  const shareCloudSettings = createMemo(() => {
    shareWorkspaceId();
    shareCloudSettingsVersion();
    return readDenSettings();
  });

  createEffect(() => {
    const handleCloudSessionUpdate = () =>
      setShareCloudSettingsVersion((value) => value + 1);
    window.addEventListener(
      "openwork-den-session-updated",
      handleCloudSessionUpdate,
    );
    onCleanup(() =>
      window.removeEventListener(
        "openwork-den-session-updated",
        handleCloudSessionUpdate,
      ),
    );
  });

  const shareWorkspaceProfileTeamOrgName = createMemo(() => {
    const orgName = shareCloudSettings().activeOrgName?.trim();
    if (orgName) return orgName;
    return t("session.share_active_cloud_org");
  });

  const shareWorkspaceProfileToTeamNeedsSignIn = createMemo(
    () => !shareCloudSettings().authToken?.trim(),
  );

  const shareWorkspaceProfileTeamDisabledReason = createMemo(() => {
    const exportReason = shareServiceDisabledReason();
    if (exportReason) return exportReason;
    if (shareWorkspaceProfileToTeamNeedsSignIn()) return null;
    const settings = shareCloudSettings();
    if (!settings.activeOrgId?.trim() && !settings.activeOrgSlug?.trim()) {
      return t("session.share_choose_org");
    }
    return null;
  });

  const startShareWorkspaceProfileToTeamSignIn = () => {
    const settings = readDenSettings();
    options.openLink(buildDenAuthUrl(settings.baseUrl, "sign-in"));
  };

  const resolveShareExportContext = async (): Promise<{
    client: ReturnType<typeof createOpenworkServerClient>;
    workspaceId: string;
    workspace: WorkspaceInfo;
  }> => {
    const workspace = shareWorkspace();
    if (!workspace) {
      throw new Error(t("session.share_select_workspace"));
    }

    if (workspace.workspaceType !== "remote") {
      const baseUrl = options.openworkServerHostInfo()?.baseUrl?.trim() ?? "";
      const token =
        options.openworkServerHostInfo()?.ownerToken?.trim() ||
        options.openworkServerHostInfo()?.clientToken?.trim() ||
        "";
      if (!baseUrl || !token) {
        throw new Error(t("session.share_local_host_not_ready"));
      }
      const client = createOpenworkServerClient({ baseUrl, token });

      let workspaceId = shareLocalOpenworkWorkspaceId()?.trim() ?? "";
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
      options.openworkServerSettings().token?.trim() ||
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
  };

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const { client, workspaceId, workspace } = await resolveShareExportContext();
      const result = await publishWorkspaceProfileBundleFromWorkspace({
        client,
        workspaceId,
        workspaceName: options.workspaceLabel(workspace),
        sensitiveMode: shareWorkspaceProfileSensitiveMode(),
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
        error instanceof Error
          ? error.message
          : t("session.share_publish_workspace_failed"),
      );
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const shareWorkspaceProfileToTeam = async (templateName: string) => {
    if (shareWorkspaceProfileTeamBusy()) return;
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
        sensitiveMode: shareWorkspaceProfileSensitiveMode(),
      });

      setShareWorkspaceProfileTeamSuccess(
        t("session.share_saved_to_org", undefined, { name: created.name, org: orgName || t("session.share_team_fallback_name") }),
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
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
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
  };

  const exportDisabledReason = createMemo(() => {
    const workspace = shareWorkspace();
    if (!workspace) return t("session.export_desktop_only_local");
    if (workspace.workspaceType === "remote") {
      return t("session.export_local_only");
    }
    if (!isTauriRuntime()) return t("session.export_desktop_only");
    if (options.exportWorkspaceBusy()) return t("session.export_already_running");
    return null;
  });

  return {
    shareWorkspaceId,
    shareWorkspaceOpen: createMemo(() => Boolean(shareWorkspaceId())),
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

function readWorkspaceExportWarnings(error: unknown): OpenworkWorkspaceExportWarning[] | null {
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
