import type { SetStateAction } from "react";

import { readDenSettings, type DenOrgSummary, type DenWorkerSummary } from "../../../app/lib/den";
import type { CreateWorkspaceScreen } from "./types";

export type CreateWorkspaceLocalState = {
  screen: CreateWorkspaceScreen;
  selectedFolder: string | null;
  pickingFolder: boolean;
  showProgressDetails: boolean;
  now: number;
  cloudSettings: ReturnType<typeof readDenSettings>;
  remoteUrl: string;
  remoteToken: string;
  remoteDisplayName: string;
  remoteTokenVisible: boolean;
  orgs: DenOrgSummary[];
  activeOrgId: string;
  orgsBusy: boolean;
  orgsError: string | null;
  workers: DenWorkerSummary[];
  workersBusy: boolean;
  workersError: string | null;
  openingWorkerId: string | null;
  workerSearch: string;
};

type CreateWorkspaceLocalAction<K extends keyof CreateWorkspaceLocalState = keyof CreateWorkspaceLocalState> =
  | { type: "set"; key: K; value: SetStateAction<any> }
  | { type: "reset"; settings: ReturnType<typeof readDenSettings> };

export function createInitialWorkspaceLocalState(settings = readDenSettings()): CreateWorkspaceLocalState {
  return {
    screen: "chooser",
    selectedFolder: null,
    pickingFolder: false,
    showProgressDetails: false,
    now: Date.now(),
    cloudSettings: settings,
    remoteUrl: "",
    remoteToken: "",
    remoteDisplayName: "",
    remoteTokenVisible: false,
    orgs: [],
    activeOrgId: settings.activeOrgId?.trim() ?? "",
    orgsBusy: false,
    orgsError: null,
    workers: [],
    workersBusy: false,
    workersError: null,
    openingWorkerId: null,
    workerSearch: "",
  };
}

export function createWorkspaceLocalReducer(
  state: CreateWorkspaceLocalState,
  action: CreateWorkspaceLocalAction,
): CreateWorkspaceLocalState {
  if (action.type === "reset") return createInitialWorkspaceLocalState(action.settings);
  const current = state[action.key];
  const next =
    typeof action.value === "function"
      ? (action.value as (value: typeof current) => typeof current)(current)
      : action.value;
  if (Object.is(current, next)) return state;
  return { ...state, [action.key]: next };
}
