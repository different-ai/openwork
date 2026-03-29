import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";

import { currentLocale, t } from "../../i18n";
import type { OpenworkServerClient } from "../lib/openwork-server";
import { pickDirectory } from "../lib/tauri";
import { isTauriRuntime, normalizeDirectoryQueryPath, safeStringify } from "../utils";

export type AuthorizedFoldersContextValue = {
  authorizedFolders: Accessor<string[]>;
  authorizedFolderDraft: Accessor<string>;
  setAuthorizedFolderDraft: (value: string) => void;
  authorizedFoldersLoading: Accessor<boolean>;
  authorizedFoldersSaving: Accessor<boolean>;
  authorizedFoldersError: Accessor<string | null>;
  authorizedFoldersStatus: Accessor<string | null>;
  authorizedFoldersAvailable: Accessor<boolean>;
  authorizedFoldersEditable: Accessor<boolean>;
  authorizedFoldersHint: Accessor<string | null>;
  addAuthorizedFolder: () => Promise<void>;
  pickAuthorizedFolder: () => Promise<void>;
  removeAuthorizedFolder: (folder: string) => Promise<void>;
};

type CreateAuthorizedFoldersStoreOptions = {
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  runtimeWorkspaceId: Accessor<string | null>;
  openworkServerReady: Accessor<boolean>;
  openworkServerWorkspaceReady: Accessor<boolean>;
  openworkServerCanReadConfig: Accessor<boolean>;
  openworkServerCanWriteConfig: Accessor<boolean>;
  selectedWorkspaceRoot: Accessor<string>;
  markOpencodeConfigReloadRequired: () => void;
};

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
      ? `Preserving ${preservedCount} non-folder permission ${preservedCount === 1 ? "entry" : "entries"}.`
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

export function createAuthorizedFoldersStore(
  options: CreateAuthorizedFoldersStoreOptions,
): AuthorizedFoldersContextValue {
  const [authorizedFolders, setAuthorizedFolders] = createSignal<string[]>([]);
  const [authorizedFolderDraft, setAuthorizedFolderDraft] = createSignal("");
  const [, setAuthorizedFolderHiddenEntries] = createSignal<Record<string, unknown>>({});
  const [authorizedFoldersLoading, setAuthorizedFoldersLoading] = createSignal(false);
  const [authorizedFoldersSaving, setAuthorizedFoldersSaving] = createSignal(false);
  const [authorizedFoldersStatus, setAuthorizedFoldersStatus] = createSignal<string | null>(null);
  const [authorizedFoldersError, setAuthorizedFoldersError] = createSignal<string | null>(null);

  createEffect(() => {
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    const canReadConfig = options.openworkServerCanReadConfig();

    if (!openworkClient || !openworkWorkspaceId || !canReadConfig) {
      setAuthorizedFolders([]);
      setAuthorizedFolderDraft("");
      setAuthorizedFolderHiddenEntries({});
      setAuthorizedFoldersLoading(false);
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
        const config = await openworkClient.getConfig(openworkWorkspaceId);
        if (cancelled) return;
        const next = readAuthorizedFoldersFromConfig(ensureRecord(config.opencode));
        setAuthorizedFolders(next.folders);
        setAuthorizedFolderHiddenEntries(next.hiddenEntries);
        setAuthorizedFoldersStatus(buildAuthorizedFoldersStatus(Object.keys(next.hiddenEntries).length));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : safeStringify(error);
        setAuthorizedFolders([]);
        setAuthorizedFolderHiddenEntries({});
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
    const openworkClient = options.openworkServerClient();
    const openworkWorkspaceId = options.runtimeWorkspaceId();
    if (!openworkClient || !openworkWorkspaceId || !options.openworkServerCanWriteConfig()) {
      setAuthorizedFoldersError(
        "A writable OpenWork server workspace is required to update authorized folders.",
      );
      return false;
    }

    setAuthorizedFoldersSaving(true);
    setAuthorizedFoldersError(null);
    setAuthorizedFoldersStatus("Saving authorized folders...");

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
      setAuthorizedFolderHiddenEntries(currentAuthorizedFolders.hiddenEntries);
      setAuthorizedFoldersStatus(
        buildAuthorizedFoldersStatus(
          Object.keys(currentAuthorizedFolders.hiddenEntries).length,
          "Authorized folders updated.",
        ),
      );
      options.markOpencodeConfigReloadRequired();
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
    const workspaceRoot = normalizeAuthorizedFolderPath(options.selectedWorkspaceRoot().trim());
    if (!normalized) return;
    if (workspaceRoot && normalized === workspaceRoot) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus("Workspace root is already available.");
      setAuthorizedFoldersError(null);
      return;
    }
    if (authorizedFolders().includes(normalized)) {
      setAuthorizedFolderDraft("");
      setAuthorizedFoldersStatus("Folder is already authorized.");
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
      const selection = await pickDirectory({ title: t("onboarding.authorize_folder", currentLocale()) });
      const folder =
        typeof selection === "string" ? selection : Array.isArray(selection) ? selection[0] : null;
      const normalized = normalizeAuthorizedFolderPath(folder);
      const workspaceRoot = normalizeAuthorizedFolderPath(options.selectedWorkspaceRoot().trim());
      if (!normalized) return;
      setAuthorizedFolderDraft(normalized);
      if (workspaceRoot && normalized === workspaceRoot) {
        setAuthorizedFolderDraft("");
        setAuthorizedFoldersStatus("Workspace root is already available.");
        setAuthorizedFoldersError(null);
        return;
      }
      if (authorizedFolders().includes(normalized)) {
        setAuthorizedFoldersStatus("Folder is already authorized.");
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

  const authorizedFoldersHint = createMemo<string | null>(() => {
    if (!options.openworkServerReady()) return "OpenWork server is disconnected.";
    if (!options.openworkServerWorkspaceReady()) return "No active server workspace is selected.";
    if (!options.openworkServerCanReadConfig()) {
      return "OpenWork server config access is unavailable for this workspace.";
    }
    if (!options.openworkServerCanWriteConfig()) {
      return "OpenWork server is connected read-only for workspace config.";
    }
    return null;
  });

  return {
    authorizedFolders,
    authorizedFolderDraft,
    setAuthorizedFolderDraft,
    authorizedFoldersLoading,
    authorizedFoldersSaving,
    authorizedFoldersError,
    authorizedFoldersStatus,
    authorizedFoldersAvailable: options.openworkServerCanReadConfig,
    authorizedFoldersEditable: options.openworkServerCanWriteConfig,
    authorizedFoldersHint,
    addAuthorizedFolder,
    pickAuthorizedFolder,
    removeAuthorizedFolder,
  };
}

const AuthorizedFoldersContext = createContext<AuthorizedFoldersContextValue | undefined>(undefined);

export function AuthorizedFoldersProvider(props: ParentProps<{ value: AuthorizedFoldersContextValue }>) {
  return (
    <AuthorizedFoldersContext.Provider value={props.value}>
      {props.children}
    </AuthorizedFoldersContext.Provider>
  );
}

export function useAuthorizedFolders() {
  const context = useContext(AuthorizedFoldersContext);
  if (!context) {
    throw new Error("Authorized folders context is missing");
  }
  return context;
}
