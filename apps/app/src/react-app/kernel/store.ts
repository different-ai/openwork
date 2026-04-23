import { create } from "zustand";

import type {
  OpenworkServerCapabilities,
  OpenworkServerDiagnostics,
  OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";

export type ServerState = {
  url: string;
  token: string;
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  version: string | null;
  capabilities: OpenworkServerCapabilities | null;
  diagnostics: OpenworkServerDiagnostics | null;
};

const INITIAL_SERVER: ServerState = {
  url: "",
  token: "",
  status: "idle",
  error: null,
  version: null,
  capabilities: null,
  diagnostics: null,
};

export type OpenworkStore = {
  bootstrapping: boolean;
  server: ServerState;
  workspaces: OpenworkWorkspaceInfo[];
  activeWorkspaceId: string | null;
  selectedSessionId: string | null;
  errorBanner: string | null;
  setBootstrapping: (value: boolean) => void;
  setServer: (server: ServerState) => void;
  setWorkspaces: (workspaces: OpenworkWorkspaceInfo[]) => void;
  setActiveWorkspaceId: (workspaceId: string | null) => void;
  setSelectedSessionId: (sessionId: string | null) => void;
  setErrorBanner: (message: string | null) => void;
  clearErrorBanner: () => void;
};

export const useOpenworkStore = create<OpenworkStore>((set) => ({
  bootstrapping: true,
  server: INITIAL_SERVER,
  workspaces: [],
  activeWorkspaceId: null,
  selectedSessionId: null,
  errorBanner: null,
  setBootstrapping: (value) => set({ bootstrapping: value }),
  setServer: (server) => set({ server }),
  setWorkspaces: (workspaces) => set({ workspaces }),
  setActiveWorkspaceId: (workspaceId) => set({ activeWorkspaceId: workspaceId }),
  setSelectedSessionId: (sessionId) => set({ selectedSessionId: sessionId }),
  setErrorBanner: (message) => set({ errorBanner: message }),
  clearErrorBanner: () => set({ errorBanner: null }),
}));
