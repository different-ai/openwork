import type { SetStateAction } from "react";

import type { CreateWorkspaceScreen } from "./types";

export type CreateWorkspaceLocalState = {
  screen: CreateWorkspaceScreen;
  selectedFolder: string | null;
  pickingFolder: boolean;
  showProgressDetails: boolean;
  now: number;
  remoteUrl: string;
  remoteToken: string;
  remoteDisplayName: string;
  remoteTokenVisible: boolean;
};

type CreateWorkspaceLocalAction<K extends keyof CreateWorkspaceLocalState = keyof CreateWorkspaceLocalState> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic key dispatch requires any
  | { type: "set"; key: K; value: SetStateAction<any> }
  | { type: "reset" };

export function createInitialWorkspaceLocalState(): CreateWorkspaceLocalState {
  return {
    screen: "chooser",
    selectedFolder: null,
    pickingFolder: false,
    showProgressDetails: false,
    now: Date.now(),
    remoteUrl: "",
    remoteToken: "",
    remoteDisplayName: "",
    remoteTokenVisible: false,
  };
}

export function createWorkspaceLocalReducer(
  state: CreateWorkspaceLocalState,
  action: CreateWorkspaceLocalAction,
): CreateWorkspaceLocalState {
  if (action.type === "reset") return createInitialWorkspaceLocalState();
  const current = state[action.key];
  const next =
    typeof action.value === "function"
      ? (action.value as (value: typeof current) => typeof current)(current)
      : action.value;
  if (Object.is(current, next)) return state;
  return { ...state, [action.key]: next };
}
