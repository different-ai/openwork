import type { OpenworkServerCapabilities, OpenworkServerDiagnostics, OpenworkServerSettings } from "../../lib/openwork-server";
import type { OpenworkServerInfo } from "../../lib/tauri";
import type { StartupPreference, WorkspaceDisplay } from "../../types";

export type ServerContractMode = "server-v2";

export type ServerTargetHostingKind = "desktop" | "self_hosted" | "cloud";
export type ServerTargetKind = "local" | "remote";
export type ServerTargetSource = "desktop-host" | "server-settings" | "selected-remote-workspace";
export type ServerContractHint = ServerContractMode | "legacy" | "unknown";

export type ServerTarget = {
  baseUrl: string;
  contractHint: ServerContractHint;
  hostToken?: string;
  hostingKind: ServerTargetHostingKind;
  kind: ServerTargetKind;
  label: string;
  legacyCapabilities: OpenworkServerCapabilities | null;
  serverId: string;
  source: ServerTargetSource;
  token?: string;
};

export type ServerVersionAccessors = {
  developerMode: () => boolean;
  openworkServerCapabilities: () => OpenworkServerCapabilities | null;
  openworkServerHostInfo: () => OpenworkServerInfo | null;
  openworkServerSettings: () => OpenworkServerSettings;
  selectedWorkspaceDisplay: () => WorkspaceDisplay;
  startupPreference: () => StartupPreference | null;
};

export type ServerStatusProbe = {
  contract: ServerContractMode;
  diagnostics: OpenworkServerDiagnostics;
  status: "connected" | "limited";
  capabilities: OpenworkServerCapabilities | null;
};

export type ExplicitServerTargetInput = {
  baseUrl: string;
  hostToken?: string;
  label?: string;
  token?: string;
};
