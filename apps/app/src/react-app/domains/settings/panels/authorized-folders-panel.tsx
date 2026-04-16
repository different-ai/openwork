/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, FolderLock, FolderSearch, X } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../../../../app/lib/openwork-server";
import { pickDirectory } from "../../../../app/lib/tauri";
import {
  isTauriRuntime,
  normalizeDirectoryQueryPath,
  safeStringify,
} from "../../../../app/utils";

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

const ensureRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const normalizeAuthorizedFolderPath = (input: string | null | undefined) => {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const withoutWildcard = trimmed.replace(/[\\/]\*+$/, "");
  return normalizeDirectoryQueryPath(withoutWildcard);
};

const authorizedFolderToExternalDirectoryKey = (folder: string) => {
  const normalized = normalizeAuthorizedFolderPath(folder);
  if (!normalized) return "";
  return normalized === "/" ? "/*" : `${normalized}/*`;
};

const externalDirectoryKeyToAuthorizedFolder = (key: string, value: unknown) => {
  if (value !== "allow") return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed === "/*") return "/";
  if (!trimmed.endsWith("/*")) return null;
  return normalizeAuthorizedFolderPath(trimmed.slice(0, -2));
};

const readAuthorizedFoldersFromConfig = (opencodeConfig: Record<string, unknown>) => {
  const permission = ensureRecord(opencodeConfig.permission);
  const externalDirectory = ensureRecord(permission.external_directory);
  const folders: string[] = [];
  const hiddenEntries: Record<string, unknown> = {};
  const seen = new Set<string>();

  for (const [key, value] of Object.entries(externalDirectory)) {
    const folder = externalDirectoryKeyToAuthorizedFolder(key, value);
    if (!folder) {
      hiddenEntries[key] = value;
      continue;
    }
    if (seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }

  return { folders, hiddenEntries };
};

const buildAuthorizedFoldersStatus = (preservedCount: number, action?: string) => {
  const preservedLabel =
    preservedCount > 0
      ? preservedCount === 1
        ? t("context_panel.preserving_entry")
        : t("context_panel.preserving_entries", undefined, { count: preservedCount })
      : null;
  if (action && preservedLabel) return `${action} ${preservedLabel}`;
  return action ?? preservedLabel;
};

const mergeAuthorizedFoldersIntoExternalDirectory = (
  folders: string[],
  hiddenEntries: Record<string, unknown>,
): Record<string, unknown> | undefined => {
  const next: Record<string, unknown> = { ...hiddenEntries };
  for (const folder of folders) {
    const key = authorizedFolderToExternalDirectoryKey(folder);
    if (!key) continue;
    next[key] = "allow";
  }
  return Object.keys(next).length ? next : undefined;
};

export function AuthorizedFoldersPanel(props: AuthorizedFoldersPanelProps) {
  const [authorizedFolders, setAuthorizedFolders] = useState<string[]>([]);
  const [authorizedFolderDraft, setAuthorizedFolderDraft] = useState("");
  const [authorizedFoldersLoading, setAuthorizedFoldersLoading] = useState(false);
  const [authorizedFoldersSaving, setAuthorizedFoldersSaving] = useState(false);
  const [authorizedFoldersStatus, setAuthorizedFoldersStatus] = useState<string | null>(null);
  const [authorizedFoldersError, setAuthorizedFoldersError] = useState<string | null>(null);

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
    isTauriRuntime() && canWriteConfig && props.activeWorkspaceType === "local";
  const workspaceRootFolder = props.selectedWorkspaceRoot.trim();
  const visibleAuthorizedFolders = useMemo(() => {
    const root = workspaceRootFolder;
    return root ? [root, ...authorizedFolders] : authorizedFolders;
  }, [authorizedFolders, workspaceRootFolder]);

  useEffect(() => {
    const openworkClient = props.openworkServerClient;
    const openworkWorkspaceId = props.runtimeWorkspaceId;

    if (!openworkClient || !openworkWorkspaceId || !canReadConfig) {
      setAuthorizedFolders([]);
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersLoading(false);
      setAuthorizedFoldersSaving(false);
      setAuthorizedFoldersStatus(null);
      setAuthorizedFoldersError(null);
      return;
    }

    let cancelled = false;
    setAuthorizedFolderDraft("");
    setAuthorizedFoldersLoading(true);
    setAuthorizedFoldersError(null);
    setAuthorizedFoldersStatus(null);

    void (async () => {
      try {
        const config = await openworkClient.getConfig(openworkWorkspaceId);
        if (cancelled) return;
        const next = readAuthorizedFoldersFromConfig(ensureRecord(config.opencode));
        setAuthorizedFolders(next.folders);
        setAuthorizedFoldersStatus(
          buildAuthorizedFoldersStatus(Object.keys(next.hiddenEntries).length),
        );
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setAuthorizedFolders([]);
        setAuthorizedFoldersError(message);
      } finally {
        if (!cancelled) setAuthorizedFoldersLoading(false);
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
    if (!isTauriRuntime()) return;
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
        <div className={`${softPanelClass} px-3 py-3 text-xs text-gray-10`}>
          {authorizedFoldersHint ?? t("context_panel.authorized_folders_no_access")}
        </div>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-xl border border-gray-5/60 bg-gray-1/50 shadow-sm">
          {authorizedFoldersHint ? (
            <div className="border-b border-gray-5/40 bg-gray-2/60 px-3 py-2 text-[11px] text-gray-10">
              {authorizedFoldersHint}
            </div>
          ) : null}

          {visibleAuthorizedFolders.length > 0 ? (
            <div className="flex max-h-[300px] flex-col divide-y divide-gray-5/40 overflow-y-auto">
              {visibleAuthorizedFolders.map((folder) => {
                const isWorkspaceRoot = folder === workspaceRootFolder;
                const folderName = folder.split(/[\/\\]/).filter(Boolean).pop() || folder;
                return (
                  <div
                    key={folder}
                    className={`flex items-center justify-between px-3 py-2.5 transition-colors ${
                      isWorkspaceRoot ? "bg-blue-2/20" : "hover:bg-gray-2/50"
                    }`}
                  >
                    <div className="flex overflow-hidden items-center gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-3/30 text-blue-11">
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
                        className="h-6 w-6 shrink-0 !rounded-full !p-0 border-0 bg-transparent text-red-10 shadow-none hover:bg-red-3/15 hover:text-red-11 focus:ring-red-7/25"
                        onClick={() => void removeAuthorizedFolder(folder)}
                        disabled={authorizedFoldersLoading || authorizedFoldersSaving || !canWriteConfig}
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
          ) : (
            <div className="flex flex-col items-center justify-center p-6 text-center">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-blue-3/30 text-blue-11">
                <Folder size={20} />
              </div>
              <div className="text-sm font-medium text-gray-11">{t("context_panel.no_external_folders")}</div>
              <div className="mt-1 max-w-[40ch] text-[11px] text-gray-9">
                {t("context_panel.add_folder_hint")}
              </div>
            </div>
          )}

          {authorizedFoldersStatus ? (
            <div className="border-t border-gray-5/40 bg-blue-2/30 px-3 py-2 text-[11px] text-blue-11">
              {authorizedFoldersStatus}
            </div>
          ) : null}
          {authorizedFoldersError ? (
            <div className="border-t border-gray-5/40 bg-red-2/30 px-3 py-2 text-[11px] text-red-11">
              {authorizedFoldersError}
            </div>
          ) : null}

          <form
            className="flex items-center gap-2 border-t border-gray-5/60 bg-gray-2/60 p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addAuthorizedFolder();
            }}
          >
            <div className="relative flex-1">
              <input
                className="w-full rounded-lg border border-gray-5/60 bg-gray-1 px-3 py-1.5 text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none focus:ring-2 focus:ring-blue-7/30 disabled:opacity-50"
                value={authorizedFolderDraft}
                onChange={(event) => setAuthorizedFolderDraft(event.currentTarget.value)}
                onPaste={(event) => {
                  event.preventDefault();
                }}
                placeholder={t("context_panel.input_placeholder")}
                disabled={authorizedFoldersLoading || authorizedFoldersSaving || !canWriteConfig}
              />
            </div>

            {canPickAuthorizedFolder ? (
              <Button
                type="button"
                variant="outline"
                className="h-8 px-3 text-xs bg-gray-1 hover:bg-gray-2"
                onClick={() => void pickAuthorizedFolder()}
                disabled={authorizedFoldersLoading || authorizedFoldersSaving || !canWriteConfig}
              >
                <FolderSearch size={13} className="mr-1.5" />
                {t("context_panel.browse_button")}
              </Button>
            ) : null}

            <Button
              type="submit"
              variant="outline"
              className="h-8 border border-gray-5/60 bg-gray-3 px-3 text-xs text-gray-12 hover:bg-gray-4"
              disabled={
                authorizedFoldersLoading ||
                authorizedFoldersSaving ||
                !canWriteConfig ||
                !authorizedFolderDraft.trim()
              }
            >
              {authorizedFoldersSaving ? t("context_panel.adding_button") : t("context_panel.add_button")}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
