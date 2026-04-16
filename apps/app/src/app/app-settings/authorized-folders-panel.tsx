import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";

import { Folder, FolderLock, FolderSearch, X } from "lucide-solid";

import { t } from "../../i18n";
import Button from "../components/button";
import type {
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import { createOpenworkServerClient } from "../lib/openwork-server";
import { pickDirectory } from "../lib/tauri";
import type { OpenworkServerInfo } from "../lib/tauri";
import {
  isTauriRuntime,
  normalizeDirectoryQueryPath,
  safeStringify,
} from "../utils";

type AuthorizedFoldersPanelProps = {
  openworkServerClient: OpenworkServerClient | null;
  openworkServerStatus: OpenworkServerStatus;
  openworkServerCapabilities: OpenworkServerCapabilities | null;
  openworkServerHostInfo: OpenworkServerInfo | null;
  runtimeWorkspaceId: string | null;
  selectedWorkspaceId: string | null;
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

const sanitizeAuthorizedFolders = (folders: string[], workspaceRoot: string) => {
  const normalizedRoot = normalizeAuthorizedFolderPath(workspaceRoot);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const folder of folders) {
    const normalized = normalizeAuthorizedFolderPath(folder);
    if (!normalized || (normalizedRoot && normalized === normalizedRoot) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
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

export default function AuthorizedFoldersPanel(props: AuthorizedFoldersPanelProps) {
  const [authorizedFolders, setAuthorizedFolders] = createSignal<string[]>([]);
  const [authorizedFolderDraft, setAuthorizedFolderDraft] = createSignal("");
  const [authorizedFoldersLoading, setAuthorizedFoldersLoading] = createSignal(false);
  const [authorizedFoldersSaving, setAuthorizedFoldersSaving] = createSignal(false);
  const [authorizedFoldersStatus, setAuthorizedFoldersStatus] = createSignal<string | null>(null);
  const [authorizedFoldersError, setAuthorizedFoldersError] = createSignal<string | null>(null);

  const openworkServerReady = createMemo(
    () => props.openworkServerStatus === "connected",
  );
  const localServerV2Client = createMemo(() => {
    if (props.activeWorkspaceType !== "local") return null;
    const hostInfo = props.openworkServerHostInfo;
    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    if (hostInfo?.startupMode !== "server-v2" || !baseUrl || !token) {
      return null;
    }
    return createOpenworkServerClient({
      baseUrl,
      hostToken: hostInfo.hostToken?.trim() || undefined,
      serverV2: {
        capabilities: props.openworkServerCapabilities?.serverV2 ?? null,
        enabled: true,
      },
      token,
    });
  });
  const effectiveOpenworkServerClient = createMemo(
    () => localServerV2Client() ?? props.openworkServerClient,
  );
  const preferredWorkspaceId = createMemo(() => {
    if (props.activeWorkspaceType === "local" && localServerV2Client()) {
      return props.selectedWorkspaceId?.trim() || null;
    }
    return props.runtimeWorkspaceId?.trim() || null;
  });
  const effectiveServerReady = createMemo(
    () => openworkServerReady() || Boolean(localServerV2Client()),
  );
  const openworkServerWorkspaceReady = createMemo(
    () => Boolean(preferredWorkspaceId() || (props.activeWorkspaceType === "local" && localServerV2Client() && props.selectedWorkspaceRoot.trim())),
  );
  const canReadConfig = createMemo(
    () =>
      effectiveServerReady() &&
      openworkServerWorkspaceReady() &&
      (localServerV2Client()
        ? (props.openworkServerCapabilities?.serverV2?.config?.read ?? true)
        : (props.openworkServerCapabilities?.config?.read ?? false)),
  );
  const canWriteConfig = createMemo(
    () =>
      effectiveServerReady() &&
      openworkServerWorkspaceReady() &&
      (localServerV2Client()
        ? (props.openworkServerCapabilities?.serverV2?.config?.write ?? true)
        : (props.openworkServerCapabilities?.config?.write ?? false)),
  );
  const authorizedFoldersHint = createMemo(() => {
    if (!effectiveServerReady()) return t("context_panel.server_disconnected");
    if (!openworkServerWorkspaceReady()) return t("context_panel.no_server_workspace");
    if (!canReadConfig()) {
      return t("context_panel.config_access_unavailable");
    }
    if (!canWriteConfig()) {
      return t("context_panel.config_read_only");
    }
    return null;
  });
  const canPickAuthorizedFolder = createMemo(
    () => isTauriRuntime() && canWriteConfig() && props.activeWorkspaceType === "local",
  );
  const workspaceRootFolder = createMemo(() => props.selectedWorkspaceRoot.trim());
  const visibleAuthorizedFolders = createMemo(() => {
    const root = workspaceRootFolder();
    const extras = sanitizeAuthorizedFolders(authorizedFolders(), root);
    return root ? [root, ...extras] : extras;
  });

  createEffect(() => {
    const openworkClient = effectiveOpenworkServerClient();
    const preferredId = preferredWorkspaceId();
    const readable = canReadConfig();

    if (!openworkClient || !readable) {
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

    const loadAuthorizedFolders = async () => {
      try {
        let openworkWorkspaceId = preferredId;
        if (!openworkWorkspaceId && props.activeWorkspaceType === "local" && localServerV2Client()) {
          const targetRoot = normalizeAuthorizedFolderPath(props.selectedWorkspaceRoot);
          if (targetRoot) {
            const response = await openworkClient.listWorkspaces();
            const items = Array.isArray(response.items) ? response.items : [];
            const match = items.find((entry) => normalizeAuthorizedFolderPath(entry.path) === targetRoot);
            openworkWorkspaceId = match?.id?.trim() || null;
          }
        }
        if (!openworkWorkspaceId) {
          setAuthorizedFolders([]);
          setAuthorizedFoldersError(null);
          setAuthorizedFoldersStatus(null);
          return;
        }

        const config = await openworkClient.getConfig(openworkWorkspaceId);
        if (cancelled) return;
        const next = readAuthorizedFoldersFromConfig(ensureRecord(config.opencode));
        setAuthorizedFolders(sanitizeAuthorizedFolders(next.folders, props.selectedWorkspaceRoot));
        setAuthorizedFoldersStatus(
          buildAuthorizedFoldersStatus(Object.keys(next.hiddenEntries).length),
        );
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setAuthorizedFolders([]);
        setAuthorizedFoldersError(message);
      } finally {
        if (!cancelled) {
          setAuthorizedFoldersLoading(false);
        }
      }
    };

    void loadAuthorizedFolders();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const persistAuthorizedFolders = async (nextFolders: string[]) => {
    const openworkClient = effectiveOpenworkServerClient();
    let openworkWorkspaceId = preferredWorkspaceId();
    if (!openworkClient || !canWriteConfig()) {
      setAuthorizedFoldersError(
        t("context_panel.writable_workspace_required"),
      );
      return false;
    }

    if (!openworkWorkspaceId && props.activeWorkspaceType === "local" && localServerV2Client()) {
      const targetRoot = normalizeAuthorizedFolderPath(props.selectedWorkspaceRoot);
      if (targetRoot) {
        const response = await openworkClient.listWorkspaces();
        const items = Array.isArray(response.items) ? response.items : [];
        const match = items.find((entry) => normalizeAuthorizedFolderPath(entry.path) === targetRoot);
        openworkWorkspaceId = match?.id?.trim() || null;
      }
    }

    if (!openworkWorkspaceId) {
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
      const sanitizedNextFolders = sanitizeAuthorizedFolders(nextFolders, props.selectedWorkspaceRoot);
      const nextExternalDirectory = mergeAuthorizedFoldersIntoExternalDirectory(
        sanitizedNextFolders,
        currentAuthorizedFolders.hiddenEntries,
      );

      await openworkClient.patchConfig(openworkWorkspaceId, {
        opencode: {
          permission: {
            external_directory: nextExternalDirectory,
          },
        },
      });
      setAuthorizedFolders(sanitizedNextFolders);
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
  };

  const addAuthorizedFolder = async () => {
    const normalized = normalizeAuthorizedFolderPath(authorizedFolderDraft());
    const workspaceRoot = normalizeAuthorizedFolderPath(workspaceRootFolder());
    if (!normalized) return;
    if (workspaceRoot && normalized === workspaceRoot) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus(t("context_panel.workspace_root_available"));
      setAuthorizedFoldersError(null);
      return;
    }
    if (authorizedFolders().includes(normalized)) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus(t("context_panel.folder_already_authorized"));
      setAuthorizedFoldersError(null);
      return;
    }

    const ok = await persistAuthorizedFolders([...authorizedFolders(), normalized]);
    if (ok) {
      setAuthorizedFolderDraft("");
    }
  };

  const removeAuthorizedFolder = async (folder: string) => {
    const nextFolders = authorizedFolders().filter((entry) => entry !== folder);
    await persistAuthorizedFolders(nextFolders);
  };

  const pickAuthorizedFolder = async () => {
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
      const workspaceRoot = normalizeAuthorizedFolderPath(workspaceRootFolder());
      if (!normalized) return;
      setAuthorizedFolderDraft(normalized);
      if (workspaceRoot && normalized === workspaceRoot) {
        setAuthorizedFolderDraft("");
        setAuthorizedFoldersStatus(t("context_panel.workspace_root_available"));
        setAuthorizedFoldersError(null);
        return;
      }
      if (authorizedFolders().includes(normalized)) {
        setAuthorizedFoldersStatus(t("context_panel.folder_already_authorized"));
        setAuthorizedFoldersError(null);
        return;
      }
      const ok = await persistAuthorizedFolders([...authorizedFolders(), normalized]);
      if (ok) {
        setAuthorizedFolderDraft("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      setAuthorizedFoldersError(message);
    }
  };

  return (
    <div class={`${panelClass} space-y-4`}>
      <div class="space-y-1">
        <div class="flex items-center gap-2 text-sm font-semibold text-gray-12">
          <FolderLock size={16} class="text-gray-10" />
          {t("context_panel.authorized_folders")}
        </div>
        <div class="text-xs text-gray-9 leading-relaxed max-w-[65ch]">
          {t("context_panel.authorized_folders_desc")}
        </div>
      </div>

      <Show
        when={canReadConfig()}
        fallback={
          <div class={`${softPanelClass} px-3 py-3 text-xs text-gray-10`}>
            {authorizedFoldersHint() ??
              t("context_panel.authorized_folders_no_access")}
          </div>
        }
      >
        <div class="flex flex-col overflow-hidden rounded-xl border border-gray-5/60 bg-gray-1/50 shadow-sm">
          <Show when={authorizedFoldersHint()}>
            {(hint) => (
              <div class="bg-gray-2/60 px-3 py-2 text-[11px] text-gray-10 border-b border-gray-5/40">
                {hint()}
              </div>
            )}
          </Show>

          <Show
            when={visibleAuthorizedFolders().length > 0}
            fallback={
              <div class="flex flex-col items-center justify-center p-6 text-center">
                <div class="flex h-10 w-10 items-center justify-center rounded-full bg-blue-3/30 text-blue-11 mb-3">
                  <Folder size={20} />
                </div>
                <div class="text-sm font-medium text-gray-11">{t("context_panel.no_external_folders")}</div>
                <div class="text-[11px] text-gray-9 mt-1 max-w-[40ch]">
                  {t("context_panel.add_folder_hint")}
                </div>
              </div>
            }
          >
            <div class="flex flex-col divide-y divide-gray-5/40 max-h-[300px] overflow-y-auto">
              <For each={visibleAuthorizedFolders()}>
                {(folder) => {
                  const isWorkspaceRoot = folder === workspaceRootFolder();
                  const folderName = folder.split(/[\/\\]/).filter(Boolean).pop() || folder;
                  return (
                    <div
                      class={`flex items-center justify-between px-3 py-2.5 transition-colors ${
                        isWorkspaceRoot ? "bg-blue-2/20" : "hover:bg-gray-2/50"
                      }`}
                    >
                      <div class="flex items-center gap-3 overflow-hidden">
                        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-3/30 text-blue-11">
                          <Folder size={15} />
                        </div>
                        <div class="flex min-w-0 flex-col">
                          <div class="flex items-center gap-2">
                            <span class="truncate text-sm font-medium text-gray-12">{folderName}</span>
                            <Show when={isWorkspaceRoot}>
                              <span class="rounded-full border border-blue-7/30 bg-blue-3/25 px-2 py-0.5 text-[10px] font-medium text-blue-11">
                                {t("context_panel.workspace_root_badge")}
                              </span>
                            </Show>
                          </div>
                          <span class="truncate font-mono text-[10px] text-gray-8">{folder}</span>
                        </div>
                      </div>
                      <Show
                        when={!isWorkspaceRoot}
                        fallback={
                          <span class="shrink-0 text-[10px] font-medium text-gray-8">
                            {t("context_panel.always_available")}
                          </span>
                        }
                      >
                        <Button
                          variant="ghost"
                          class="h-6 w-6 shrink-0 !rounded-full !p-0 border-0 bg-transparent text-red-10 shadow-none hover:bg-red-3/15 hover:text-red-11 focus:ring-red-7/25"
                          onClick={() => void removeAuthorizedFolder(folder)}
                          disabled={
                            authorizedFoldersLoading() ||
                            authorizedFoldersSaving() ||
                            !canWriteConfig()
                          }
                          aria-label={t("context_panel.remove_folder", undefined, { name: folderName })}
                        >
                          <X size={16} class="text-current" />
                        </Button>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>

          <Show when={authorizedFoldersStatus()}>
            {(status) => (
              <div class="bg-blue-2/30 px-3 py-2 text-[11px] text-blue-11 border-t border-gray-5/40">
                {status()}
              </div>
            )}
          </Show>
          <Show when={authorizedFoldersError()}>
            {(error) => (
              <div class="bg-red-2/30 px-3 py-2 text-[11px] text-red-11 border-t border-gray-5/40">
                {error()}
              </div>
            )}
          </Show>

          <form
            class="flex items-center gap-2 bg-gray-2/60 border-t border-gray-5/60 p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addAuthorizedFolder();
            }}
          >
            <div class="relative flex-1">
              <input
                class="w-full rounded-lg border border-gray-5/60 bg-gray-1 px-3 py-1.5 text-xs text-gray-12 placeholder:text-gray-8 focus:outline-none focus:ring-2 focus:ring-blue-7/30 disabled:opacity-50"
                value={authorizedFolderDraft()}
                onInput={(event) => setAuthorizedFolderDraft(event.currentTarget.value)}
                onPaste={(event) => {
                  event.preventDefault();
                }}
                placeholder={t("context_panel.input_placeholder")}
                disabled={
                  authorizedFoldersLoading() ||
                  authorizedFoldersSaving() ||
                  !canWriteConfig()
                }
              />
            </div>

            <Show when={canPickAuthorizedFolder()}>
              <Button
                type="button"
                variant="outline"
                class="h-8 px-3 text-xs bg-gray-1 hover:bg-gray-2"
                onClick={() => void pickAuthorizedFolder()}
                disabled={
                  authorizedFoldersLoading() ||
                  authorizedFoldersSaving() ||
                  !canWriteConfig()
                }
              >
                <FolderSearch size={13} class="mr-1.5" /> {t("context_panel.browse_button")}
              </Button>
            </Show>

            <Button
              type="submit"
              variant="primary"
              class="h-8 px-3 text-xs bg-gray-3 text-gray-12 hover:bg-gray-4 border border-gray-5/60"
              disabled={
                authorizedFoldersLoading() ||
                authorizedFoldersSaving() ||
                !canWriteConfig() ||
                !authorizedFolderDraft().trim()
              }
            >
              {authorizedFoldersSaving() ? t("context_panel.adding_button") : t("context_panel.add_button")}
            </Button>
          </form>
        </div>
      </Show>
    </div>
  );
}
