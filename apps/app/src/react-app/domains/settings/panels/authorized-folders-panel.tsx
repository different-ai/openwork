/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useReducer, useState, type SetStateAction } from "react";
import { Folder, Info, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../../../../app/lib/openwork-server";
import { pickDirectory } from "../../../../app/lib/desktop";
import {
  isDesktopRuntime,
  safeStringify,
} from "../../../../app/utils";
import {
  authorizedFoldersReducer,
  buildAuthorizedFoldersStatus,
  initialAuthorizedFoldersState,
  normalizeAuthorizedFolderPath,
} from "./authorized-folders-panel-state";
import {
  SettingsNotice,
} from "../settings-section";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
} from "../settings-layout";

export type AuthorizedFoldersPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  selectedWorkspaceRoot: string;
  activeWorkspaceType: "local" | "remote";
  onConfigUpdated: () => void;
};

type AuthorizedFolderItemProps = {
  folder: string;
  workspaceRootFolder: string;
  authorizedFoldersLoading: boolean;
  authorizedFoldersSaving: boolean;
  canWriteConfig: boolean;
  onRemove: (folder: string) => Promise<void>;
};

function getFolderName(folder: string) {
  // Split on POSIX "/" and Windows "\" separators, then use the last path segment as the folder name.
  return folder.split(/[\/\\]/).filter(Boolean).pop() || folder;
}

function AuthorizedFolderItem(props: AuthorizedFolderItemProps) {
  const isWorkspaceRoot = props.folder === props.workspaceRootFolder;
  const folderName = getFolderName(props.folder);

  return (
    <li className="flex flex-row items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3">
      <div className="flex min-w-0 gap-3">
        <div className="min-w-0 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Folder size={16} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-medium text-dls-text">{folderName}</span>
            {isWorkspaceRoot ? (
              <span className="shrink-0 rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {t("context_panel.workspace_root_badge")}
              </span>
            ) : null}
          </div>
          <span className="truncate font-mono text-xs text-muted-foreground ps-6">{props.folder}</span>
        </div>
      </div>
      {!isWorkspaceRoot ? (
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          onClick={() => void props.onRemove(props.folder)}
          disabled={props.authorizedFoldersLoading || props.authorizedFoldersSaving || !props.canWriteConfig}
          aria-label={t("context_panel.remove_folder", undefined, { name: folderName })}
        >
          <X size={14} />
        </Button>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={(
              <span
                className="inline-flex shrink-0 items-center text-muted-foreground mr-2"
                tabIndex={0}
              >
                <Info className="size-4" />
              </span>
            )}
          />
          <TooltipContent>{t("context_panel.always_available")}</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

export function AuthorizedFoldersPanel(props: AuthorizedFoldersPanelProps) {
  const [serverWorkspaceRoot, setServerWorkspaceRoot] = useState("");
  const [folderState, dispatchFolderState] = useReducer(
    authorizedFoldersReducer,
    initialAuthorizedFoldersState,
  );
  const {
    folders: authorizedFolders,
    loading: authorizedFoldersLoading,
    saving: authorizedFoldersSaving,
    status: authorizedFoldersStatus,
    error: authorizedFoldersError,
  } = folderState;
  const setAuthorizedFolders = (value: SetStateAction<string[]>) => dispatchFolderState({ type: "set", key: "folders", value });
  const setAuthorizedFoldersSaving = (value: SetStateAction<boolean>) => dispatchFolderState({ type: "set", key: "saving", value });
  const setAuthorizedFoldersStatus = (value: SetStateAction<string | null>) => dispatchFolderState({ type: "set", key: "status", value });
  const setAuthorizedFoldersError = (value: SetStateAction<string | null>) => dispatchFolderState({ type: "set", key: "error", value });

  const openworkServerReady = props.openworkServerStatus === "connected";
  const openworkServerWorkspaceReady = Boolean(props.runtimeWorkspaceId);
  const canReadConfig =
    openworkServerReady &&
    openworkServerWorkspaceReady &&
    (props.openworkServerCapabilities?.config?.read ?? false);
  const canWriteConfig =
    openworkServerReady &&
    openworkServerWorkspaceReady &&
    (props.openworkServerCapabilities?.config?.write ?? false);

  const authorizedFoldersHint = useMemo(() => {
    if (!openworkServerReady) return t("context_panel.server_disconnected");
    if (!openworkServerWorkspaceReady) return t("context_panel.no_server_workspace");
    if (!canReadConfig) return t("context_panel.config_access_unavailable");
    if (!canWriteConfig) return t("context_panel.config_read_only");
    return null;
  }, [canReadConfig, canWriteConfig, openworkServerReady, openworkServerWorkspaceReady]);

  const canPickAuthorizedFolder =
    isDesktopRuntime() && canWriteConfig && props.activeWorkspaceType === "local";
  const workspaceRootFolder = serverWorkspaceRoot || props.selectedWorkspaceRoot.trim();
  const visibleAuthorizedFolders = useMemo(() => {
    const root = workspaceRootFolder;
    return root ? [root, ...authorizedFolders.filter((folder) => folder !== root)] : authorizedFolders;
  }, [authorizedFolders, workspaceRootFolder]);

  useEffect(() => {
    const openworkClient = props.openworkServerClient;
    const openworkWorkspaceId = props.runtimeWorkspaceId;

    if (!openworkClient || !openworkWorkspaceId || !canReadConfig) {
      setServerWorkspaceRoot("");
      dispatchFolderState({ type: "reset" });
      return;
    }

    let cancelled = false;
    dispatchFolderState({ type: "loadStart" });

    void (async () => {
      try {
        const response = await openworkClient.listAuthorizedFolders(openworkWorkspaceId);
        if (cancelled) return;
        setServerWorkspaceRoot(response.workspaceRoot.trim());
        dispatchFolderState({
          type: "loadSuccess",
          folders: response.folders,
          status: buildAuthorizedFoldersStatus(response.hiddenCount),
        });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        dispatchFolderState({ type: "loadError", message });
      } finally {
        if (!cancelled) dispatchFolderState({ type: "loadDone" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [canReadConfig, props.openworkServerClient, props.runtimeWorkspaceId]);

  const persistAuthorizedFolders = useCallback(async (nextFolders: string[]) => {
    const openworkClient = props.openworkServerClient;
    const openworkWorkspaceId = props.runtimeWorkspaceId;
    if (!openworkClient || !openworkWorkspaceId || !canWriteConfig) {
      setAuthorizedFoldersError(t("context_panel.writable_workspace_required"));
      return false;
    }

    setAuthorizedFoldersSaving(true);
    setAuthorizedFoldersError(null);
    setAuthorizedFoldersStatus(t("context_panel.saving_folders"));

    try {
      const response = await openworkClient.setAuthorizedFolders(openworkWorkspaceId, nextFolders);
      setAuthorizedFolders(response.folders);
      setAuthorizedFoldersStatus(
        buildAuthorizedFoldersStatus(
          response.hiddenCount,
          t("context_panel.folders_updated"),
        ),
      );
      props.onConfigUpdated();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setAuthorizedFoldersError(message);
      setAuthorizedFoldersStatus(null);
      return false;
    } finally {
      setAuthorizedFoldersSaving(false);
    }
  }, [canWriteConfig, props.onConfigUpdated, props.openworkServerClient, props.runtimeWorkspaceId]);

  const removeAuthorizedFolder = useCallback(async (folder: string) => {
    const nextFolders = authorizedFolders.filter((entry) => entry !== folder);
    await persistAuthorizedFolders(nextFolders);
  }, [authorizedFolders, persistAuthorizedFolders]);

  const pickAuthorizedFolder = useCallback(async () => {
    if (!isDesktopRuntime()) return;
    try {
      const selection = await pickDirectory({
        title: t("onboarding.authorize_folder"),
      });
      const folder =
        typeof selection === "string"
          ? selection
          : Array.isArray(selection)
            ? selection[0]
            : null;
      const normalized = normalizeAuthorizedFolderPath(folder);
      const workspaceRoot = normalizeAuthorizedFolderPath(workspaceRootFolder);
      if (!normalized) return;
      if (workspaceRoot && normalized === workspaceRoot) {
        setAuthorizedFoldersStatus(t("context_panel.workspace_root_available"));
        setAuthorizedFoldersError(null);
        return;
      }
      if (authorizedFolders.includes(normalized)) {
        setAuthorizedFoldersStatus(t("context_panel.folder_already_authorized"));
        setAuthorizedFoldersError(null);
        return;
      }
      await persistAuthorizedFolders([...authorizedFolders, normalized]);
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setAuthorizedFoldersError(message);
    }
  }, [authorizedFolders, persistAuthorizedFolders, workspaceRootFolder]);

  return (
    <LayoutSectionItem className="gap-6">
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>
          {t("context_panel.authorized_folders")}
        </LayoutSectionItemTitle>
        <LayoutSectionItemDescription>
          {t("context_panel.authorized_folders_desc")}
        </LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Button
            onClick={() => void pickAuthorizedFolder()}
            disabled={authorizedFoldersLoading || authorizedFoldersSaving || !canPickAuthorizedFolder}
          >
            <Plus className="size-4" />
            Add folder
          </Button>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>

      {!canReadConfig ? (
        <SettingsNotice>
          {authorizedFoldersHint ?? t("context_panel.authorized_folders_no_access")}
        </SettingsNotice>
      ) : (
        <>
          {/* Folder list */}
          {visibleAuthorizedFolders.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {visibleAuthorizedFolders.map((folder) => (
                <AuthorizedFolderItem
                  key={folder}
                  folder={folder}
                  workspaceRootFolder={workspaceRootFolder}
                  authorizedFoldersLoading={authorizedFoldersLoading}
                  authorizedFoldersSaving={authorizedFoldersSaving}
                  canWriteConfig={canWriteConfig}
                  onRemove={removeAuthorizedFolder}
                />
              ))}
            </ul>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia>
                  <Folder className="text-muted-foreground" />
                </EmptyMedia>
                <EmptyTitle>
                  {t("context_panel.no_external_folders")}
                </EmptyTitle>
                <EmptyDescription>
                  {t("context_panel.add_folder_hint")}
                </EmptyDescription>
              </EmptyHeader>
            <EmptyContent>
              <Button
                onClick={() => void pickAuthorizedFolder()}
                disabled={authorizedFoldersLoading || authorizedFoldersSaving || !canPickAuthorizedFolder}
              >
                <Plus className="size-4" />
                Add folder
              </Button>
            </EmptyContent>
            </Empty>
          )}

          {/* Status / error */}
          {authorizedFoldersStatus ? (
            <SettingsNotice>{authorizedFoldersStatus}</SettingsNotice>
          ) : null}
          {authorizedFoldersError ? (
            <SettingsNotice tone="error">{authorizedFoldersError}</SettingsNotice>
          ) : null}
        </>
      )}
    </LayoutSectionItem>
  );
}
