import { createContext, useContext, type Accessor, type ParentProps } from "solid-js";

import type {
  OpenworkAuditEntry,
  OpenworkServerCapabilities,
  OpenworkServerClient,
  OpenworkServerDiagnostics,
  OpenworkServerSettings,
  OpenworkServerStatus,
} from "../lib/openwork-server";
import type { OpenworkServerInfo } from "../lib/tauri";

export type OpenworkServerContextValue = {
  openworkServerStatus: Accessor<OpenworkServerStatus>;
  openworkServerUrl: Accessor<string>;
  openworkServerClient: Accessor<OpenworkServerClient | null>;
  openworkReconnectBusy: Accessor<boolean>;
  reconnectOpenworkServer: () => Promise<boolean>;
  openworkServerSettings: Accessor<OpenworkServerSettings>;
  openworkServerHostInfo: Accessor<OpenworkServerInfo | null>;
  openworkServerCapabilities: Accessor<OpenworkServerCapabilities | null>;
  openworkServerDiagnostics: Accessor<OpenworkServerDiagnostics | null>;
  runtimeWorkspaceId: Accessor<string | null>;
  openworkAuditEntries: Accessor<OpenworkAuditEntry[]>;
  openworkAuditStatus: Accessor<"idle" | "loading" | "error">;
  openworkAuditError: Accessor<string | null>;
  shareRemoteAccessBusy: Accessor<boolean>;
  shareRemoteAccessError: Accessor<string | null>;
  saveShareRemoteAccess: (enabled: boolean) => Promise<void>;
};

const OpenworkServerContext = createContext<OpenworkServerContextValue | undefined>(undefined);

export function OpenworkServerProvider(props: ParentProps<{ value: OpenworkServerContextValue }>) {
  return (
    <OpenworkServerContext.Provider value={props.value}>
      {props.children}
    </OpenworkServerContext.Provider>
  );
}

export function useOpenworkServer() {
  const context = useContext(OpenworkServerContext);
  if (!context) {
    throw new Error("OpenWork server context is missing");
  }
  return context;
}
