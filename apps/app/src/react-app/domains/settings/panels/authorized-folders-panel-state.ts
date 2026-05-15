import type { SetStateAction } from "react";

import { t } from "../../../../i18n";
import { normalizeDirectoryQueryPath } from "../../../../app/utils";

export type AuthorizedFoldersState = {
  folders: string[];
  draft: string;
  loading: boolean;
  saving: boolean;
  status: string | null;
  error: string | null;
};

type AuthorizedFoldersAction =
  | { type: "set"; key: keyof AuthorizedFoldersState; value: SetStateAction<any> }
  | { type: "reset" }
  | { type: "loadStart" }
  | { type: "loadSuccess"; folders: string[]; status: string | null }
  | { type: "loadError"; message: string }
  | { type: "loadDone" };

export const initialAuthorizedFoldersState: AuthorizedFoldersState = {
  folders: [],
  draft: "",
  loading: false,
  saving: false,
  status: null,
  error: null,
};

export function authorizedFoldersReducer(
  state: AuthorizedFoldersState,
  action: AuthorizedFoldersAction,
): AuthorizedFoldersState {
  switch (action.type) {
    case "set": {
      const current = state[action.key];
      const next =
        typeof action.value === "function"
          ? (action.value as (value: typeof current) => typeof current)(current)
          : action.value;
      if (Object.is(current, next)) return state;
      return { ...state, [action.key]: next };
    }
    case "reset":
      return initialAuthorizedFoldersState;
    case "loadStart":
      return { ...state, draft: "", loading: true, error: null, status: null };
    case "loadSuccess":
      return { ...state, folders: action.folders, status: action.status };
    case "loadError":
      return { ...state, folders: [], error: action.message };
    case "loadDone":
      return { ...state, loading: false };
  }
}

export const ensureRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

export const normalizeAuthorizedFolderPath = (input: string | null | undefined) => {
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

export const readAuthorizedFoldersFromConfig = (opencodeConfig: Record<string, unknown>) => {
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

export const buildAuthorizedFoldersStatus = (preservedCount: number, action?: string) => {
  const preservedLabel =
    preservedCount > 0
      ? preservedCount === 1
        ? t("context_panel.preserving_entry")
        : t("context_panel.preserving_entries", undefined, { count: preservedCount })
      : null;
  if (action && preservedLabel) return `${action} ${preservedLabel}`;
  return action ?? preservedLabel;
};

export const mergeAuthorizedFoldersIntoExternalDirectory = (
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
