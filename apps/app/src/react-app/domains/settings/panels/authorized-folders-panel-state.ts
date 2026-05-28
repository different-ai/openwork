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

type AuthorizedFoldersSetAction = {
  [K in keyof AuthorizedFoldersState]: { type: "set"; key: K; value: SetStateAction<AuthorizedFoldersState[K]> };
}[keyof AuthorizedFoldersState];

type AuthorizedFoldersAction =
  | AuthorizedFoldersSetAction
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

export const normalizeAuthorizedFolderPath = (input: string | null | undefined) => {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return "";
  const withoutWildcard = trimmed.replace(/[\\/]\*+$/, "");
  return normalizeDirectoryQueryPath(withoutWildcard);
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
