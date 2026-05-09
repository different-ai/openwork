/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useReducer, type SetStateAction } from "react";
import { Folder, FolderLock, FolderSearch, X } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
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
  ensureRecord,
  initialAuthorizedFoldersState,
  mergeAuthorizedFoldersIntoExternalDirectory,
  normalizeAuthorizedFolderPath,
  readAuthorizedFoldersFromConfig,
  type AuthorizedFoldersState,
} from "./authorized-folders-panel-state";

export type AuthorizedFoldersPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  runtimeWorkspaceId: string | null;
  selectedWorkspaceRoot: string;
  activeWorkspaceType: "local" | "remote";
  onConfigUpdated: () => void;
};

const panelClass = "rounded-[28px] border border-dls-border bg-dls-surface p-5 md:p-6";
const softPanelClass = "rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4";

export function AuthorizedFoldersPanel(props: AuthorizedFoldersPanelProps) {
  const [folderState, dispatchFolderState] = useReducer(
    authorizedFoldersReducer,
    initialAuthorizedFoldersState,
  );
  const {
    folders: authorizedFolders,
    draft: authorizedFolderDraft,
    loading: authorizedFoldersLoading,
    saving: authorizedFoldersSaving,
    status: authorizedFoldersStatus,
    error: authorizedFoldersError,
  } = folderState;
  const setFolderState = <K extends keyof AuthorizedFoldersState>(
    key: K,
    value: SetStateAction<AuthorizedFoldersState[K]>,
  ) => dispatchFolderState({ type: "set", key, value });
  const setAuthorizedFolders = (value: SetStateAction<string[]>) => setFolderState("folders", value);
  const setAuthorizedFolderDraft = (value: SetStateAction<string>) => setFolderState("draft", value);
  const setAuthorizedFoldersSaving = (value: SetStateAction<boolean>) => setFolderState("saving", value);
  const setAuthorizedFoldersStatus = (value: SetStateAction<string | null>) => setFolderState("status", value);
  const setAuthorizedFoldersError = (value: SetStateAction<string | null>) => setFolderState("error", value);

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
  const workspaceRootFolder = props.selectedWorkspaceRoot.trim();
  const visibleAuthorizedFolders = useMemo(() => {
    const root = workspaceRootFolder;
    return root ? [root, ...authorizedFolders] : authorizedFolders;
  }, [authorizedFolders, workspaceRootFolder]);

  useEffect(() => {
    const openworkClient = props.openworkServerClient;
    const openworkWorkspaceId = props.runtimeWorkspaceId;

    if (!openworkClient || !openworkWorkspaceId || !canReadConfig) {
      dispatchFolderState({ type: "reset" });
      return;
    }

    let cancelled = false;
    dispatchFolderState({ type: "loadStart" });

    void (async () => {
      try {
        const config = await openworkClient.getConfig(openworkWorkspaceId);
        if (cancelled) return;
        const next = readAuthorizedFoldersFromConfig(ensureRecord(config.opencode));
        dispatchFolderState({
          type: "loadSuccess",
          folders: next.folders,
          status: buildAuthorizedFoldersStatus(Object.keys(next.hiddenEntries).length),
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
      const currentConfig = await openworkClient.getConfig(openworkWorkspaceId);
      const currentAuthorizedFolders = readAuthorizedFoldersFromConfig(
        ensureRecord(currentConfig.opencode),
      );
      const nextExternalDirectory = mergeAuthorizedFoldersIntoExternalDirectory(
        nextFolders,
        currentAuthorizedFolders.hiddenEntries,
      );

      await openworkClient.patchConfig(openworkWorkspaceId, {
        opencode: {
          permission: {
            external_directory: nextExternalDirectory,
          },
        },
      });
      setAuthorizedFolders(nextFolders);
      setAuthorizedFoldersStatus(
        buildAuthorizedFoldersStatus(
          Object.keys(currentAuthorizedFolders.hiddenEntries).length,
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
  }, [canWriteConfig, props]);

  const addAuthorizedFolder = useCallback(async () => {
    const normalized = normalizeAuthorizedFolderPath(authorizedFolderDraft);
    const workspaceRoot = normalizeAuthorizedFolderPath(workspaceRootFolder);
    if (!normalized) return;
    if (workspaceRoot && normalized === workspaceRoot) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus(t("context_panel.workspace_root_available"));
      setAuthorizedFoldersError(null);
      return;
    }
    if (authorizedFolders.includes(normalized)) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus(t("context_panel.folder_already_authorized"));
      setAuthorizedFoldersError(null);
      return;
    }

    const ok = await persistAuthorizedFolders([...authorizedFolders, normalized]);
    if (ok) {
      setAuthorizedFolderDraft("");
    }
  }, [authorizedFolderDraft, authorizedFolders, persistAuthorizedFolders, workspaceRootFolder]);

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
      setAuthorizedFolderDraft(normalized);
      if (workspaceRoot && normalized === workspaceRoot) {
        setAuthorizedFolderDraft("");
        setAuthorizedFoldersStatus(t("context_panel.workspace_root_available"));
        setAuthorizedFoldersError(null);
        return;
      }
      if (authorizedFolders.includes(normalized)) {
        setAuthorizedFoldersStatus(t("context_panel.folder_already_authorized"));
        setAuthorizedFoldersError(null);
        return;
      }
      const ok = await persistAuthorizedFolders([...authorizedFolders, normalized]);
      if (ok) {
        setAuthorizedFolderDraft("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setAuthorizedFoldersError(message);
    }
  }, [authorizedFolders, persistAuthorizedFolders, workspaceRootFolder]);

  return (
    <div className={`${panelClass} space-y-4`}>
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-gray-12">
          <FolderLock size={16} className="text-gray-10" />
          {t("context_panel.authorized_folders")}
        </div>
        <div className="max-w-[65ch] text-xs leading-relaxed text-gray-9">
          {t("context_panel.authorized_folders_desc")}
        </div>
      </div>

      {!canReadConfig ? (
        <div className={`${softPanelClass} p-3 text-xs text-gray-10`}>
          {authorizedFoldersHint ?? t("context_panel.authorized_folders_no_access")}
        </div>
      ) : (
        <AuthorizedFoldersEditor
          hint={authorizedFoldersHint}
          folders={visibleAuthorizedFolders}
          workspaceRootFolder={workspaceRootFolder}
          draft={authorizedFolderDraft}
          loading={authorizedFoldersLoading}
          saving={authorizedFoldersSaving}
          status={authorizedFoldersStatus}
          error={authorizedFoldersError}
          canWriteConfig={canWriteConfig}
          canPickAuthorizedFolder={canPickAuthorizedFolder}
          onDraftChange={setAuthorizedFolderDraft}
          onAddFolder={addAuthorizedFolder}
          onPickFolder={pickAuthorizedFolder}
          onRemoveFolder={removeAuthorizedFolder}
        />
      )}
    </div>
  );
}

function AuthorizedFoldersEditor(props: {
  hint: string | null;
  folders: string[];
  workspaceRootFolder: string;
  draft: string;
  loading: boolean;
  saving: boolean;
  status: string | null;
  error: string | null;
  canWriteConfig: boolean;
  canPickAuthorizedFolder: boolean;
  onDraftChange: (value: string) => void;
  onAddFolder: () => Promise<void>;
  onPickFolder: () => Promise<void>;
  onRemoveFolder: (folder: string) => Promise<void>;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-gray-5/60 bg-gray-1/50 shadow-sm">
      {props.hint ? (
        <div className="border-b border-gray-5/40 bg-gray-2/60 px-3 py-2 text-[11px] text-gray-10">
          {props.hint}
        </div>
      ) : null}

      {props.folders.length > 0 ? (
        <AuthorizedFoldersList
          folders={props.folders}
          workspaceRootFolder={props.workspaceRootFolder}
          disabled={props.loading || props.saving || !props.canWriteConfig}
          onRemoveFolder={props.onRemoveFolder}
        />
      ) : (
        <AuthorizedFoldersEmptyState />
      )}

      {props.status ? (
        <div className="border-t border-gray-5/40 bg-blue-2/30 px-3 py-2 text-[11px] text-blue-11">
          {props.status}
        </div>
      ) : null}
      {props.error ? (
        <div className="border-t border-gray-5/40 bg-red-2/30 px-3 py-2 text-[11px] text-red-11">
          {props.error}
        </div>
      ) : null}

      <AuthorizedFoldersInput
        draft={props.draft}
        disabled={props.loading || props.saving || !props.canWriteConfig}
        saving={props.saving}
        canPickAuthorizedFolder={props.canPickAuthorizedFolder}
        onDraftChange={props.onDraftChange}
        onAddFolder={props.onAddFolder}
        onPickFolder={props.onPickFolder}
      />
    </div>
  );
}

function AuthorizedFoldersList(props: {
  folders: string[];
  workspaceRootFolder: string;
  disabled: boolean;
  onRemoveFolder: (folder: string) => Promise<void>;
}) {
  return (
    <div className="flex max-h-[300px] flex-col divide-y divide-gray-5/40 overflow-y-auto">
      {props.folders.map((folder) => {
        const isWorkspaceRoot = folder === props.workspaceRootFolder;
        const folderName = folder.split(/[\/\\]/).filter(Boolean).pop() || folder;
        return (
          <div
            key={folder}
            className={`flex items-center justify-between px-3 py-2.5 transition-colors ${
              isWorkspaceRoot ? "bg-blue-2/20" : "hover:bg-gray-2/50"
            }`}
          >
            <div className="flex overflow-hidden items-center gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-3/30 text-blue-11">
                <Folder size={15} />
              </div>
              <div className="flex min-w-0 flex-col">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-gray-12">{folderName}</span>
                  {isWorkspaceRoot ? (
                    <span className="rounded-full border border-blue-7/30 bg-blue-3/25 px-2 py-0.5 text-[10px] font-medium text-blue-11">
                      {t("context_panel.workspace_root_badge")}
                    </span>
                  ) : null}
                </div>
                <span className="truncate font-mono text-[10px] text-gray-8">{folder}</span>
              </div>
            </div>
            {!isWorkspaceRoot ? (
              <Button
                variant="ghost"
                className="size-6 shrink-0 !rounded-full !p-0 border-0 bg-transparent text-red-10 shadow-none hover:bg-red-3/15 hover:text-red-11 focus:ring-red-7/25"
                onClick={() => void props.onRemoveFolder(folder)}
                disabled={props.disabled}
                aria-label={t("context_panel.remove_folder", undefined, { name: folderName })}
              >
                <X size={16} className="text-current" />
              </Button>
            ) : (
              <span className="shrink-0 text-[10px] font-medium text-gray-8">
                {t("context_panel.always_available")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AuthorizedFoldersEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center p-6 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-blue-3/30 text-blue-11">
        <Folder size={20} />
      </div>
      <div className="text-sm font-medium text-gray-11">{t("context_panel.no_external_folders")}</div>
      <div className="mt-1 max-w-[40ch] text-[11px] text-gray-9">
        {t("context_panel.add_folder_hint")}
      </div>
    </div>
  );
}

function AuthorizedFoldersInput(props: {
  draft: string;
  disabled: boolean;
  saving: boolean;
  canPickAuthorizedFolder: boolean;
  onDraftChange: (value: string) => void;
  onAddFolder: () => Promise<void>;
  onPickFolder: () => Promise<void>;
}) {
  return (
    <div className="flex items-center gap-2 border-t border-gray-5/60 bg-gray-2/60 p-2">
      <div className="relative flex-1">
        <input
          className="w-full rounded-lg border border-gray-5/60 bg-gray-1 px-3 py-1.5 text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none focus:ring-2 focus:ring-blue-7/30 disabled:opacity-50"
          value={props.draft}
          onChange={(event) => props.onDraftChange(event.currentTarget.value)}
          onPaste={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && props.draft.trim()) {
              void props.onAddFolder();
            }
          }}
          placeholder={t("context_panel.input_placeholder")}
          disabled={props.disabled}
        />
      </div>

      {props.canPickAuthorizedFolder ? (
        <Button
          type="button"
          variant="outline"
          className="h-8 px-3 text-xs bg-gray-1 hover:bg-gray-2"
          onClick={() => void props.onPickFolder()}
          disabled={props.disabled}
        >
          <FolderSearch size={13} className="mr-1.5" />
          {t("context_panel.browse_button")}
        </Button>
      ) : null}

      <Button
        type="button"
        variant="outline"
        className="h-8 border border-gray-5/60 bg-gray-3 px-3 text-xs text-gray-12 hover:bg-gray-4"
        onClick={() => void props.onAddFolder()}
        disabled={props.disabled || !props.draft.trim()}
      >
        {props.saving ? t("context_panel.adding_button") : t("context_panel.add_button")}
      </Button>
    </div>
  );
}
