import type { SetStateAction } from "react";

import type { OpencodeConfigFile } from "../../../../app/lib/desktop";

export type ConfigScope = "project" | "global";

export type McpViewLocalState = {
  logoutOpen: boolean;
  logoutTarget: string | null;
  logoutBusy: boolean;
  removeOpen: boolean;
  removeTarget: string | null;
  configScope: ConfigScope;
  projectConfig: OpencodeConfigFile | null;
  globalConfig: OpencodeConfigFile | null;
  configError: string | null;
  revealBusy: boolean;
  showAdvanced: boolean;
  addMcpModalOpen: boolean;
  togglingMcp: string | null;
};

type McpViewLocalAction<K extends keyof McpViewLocalState = keyof McpViewLocalState> =
  | { type: "set"; key: K; value: SetStateAction<any> }
  | { type: "configUnavailable" }
  | { type: "configLoaded"; project: OpencodeConfigFile | null; global: OpencodeConfigFile | null }
  | { type: "configLoadError"; error: string };

export const initialMcpViewLocalState: McpViewLocalState = {
  logoutOpen: false,
  logoutTarget: null,
  logoutBusy: false,
  removeOpen: false,
  removeTarget: null,
  configScope: "project",
  projectConfig: null,
  globalConfig: null,
  configError: null,
  revealBusy: false,
  showAdvanced: false,
  addMcpModalOpen: false,
  togglingMcp: null,
};

export function mcpViewLocalReducer(
  state: McpViewLocalState,
  action: McpViewLocalAction,
): McpViewLocalState {
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
    case "configUnavailable":
      return { ...state, projectConfig: null, globalConfig: null, configError: null };
    case "configLoaded":
      return { ...state, projectConfig: action.project, globalConfig: action.global };
    case "configLoadError":
      return { ...state, projectConfig: null, globalConfig: null, configError: action.error };
  }
}
