/** @jsxImportSource react */
import type { McpDirectoryInfo } from "../../../app/constants";
import type { OpencodeConfigFile } from "../../../app/lib/tauri";
import type { McpServerEntry, McpStatusMap } from "../../../app/types";

import PresentationalMcpView from "../settings/pages/mcp-view";

export type ConnectionsMcpStore = {
  readConfigFile?: (scope: "project" | "global") => Promise<OpencodeConfigFile | null>;
  mcpServers: McpServerEntry[];
  mcpStatus: string | null;
  mcpLastUpdatedAt: number | null;
  mcpStatuses: McpStatusMap;
  mcpConnectingName: string | null;
  selectedMcp: string | null;
  setSelectedMcp: (name: string | null) => void;
  quickConnect: McpDirectoryInfo[];
  connectMcp: (entry: McpDirectoryInfo) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  logoutMcpAuth: (name: string) => Promise<void> | void;
  removeMcp: (name: string) => void;
};

export type ConnectionsMcpViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  showHeader?: boolean;
  connections: ConnectionsMcpStore;
};

export default function ConnectionsMcpView(props: ConnectionsMcpViewProps) {
  const { connections } = props;

  return (
    <PresentationalMcpView
      showHeader={props.showHeader}
      busy={props.busy}
      selectedWorkspaceRoot={props.selectedWorkspaceRoot}
      isRemoteWorkspace={props.isRemoteWorkspace}
      readConfigFile={connections.readConfigFile}
      mcpServers={connections.mcpServers}
      mcpStatus={connections.mcpStatus}
      mcpLastUpdatedAt={connections.mcpLastUpdatedAt}
      mcpStatuses={connections.mcpStatuses}
      mcpConnectingName={connections.mcpConnectingName}
      selectedMcp={connections.selectedMcp}
      setSelectedMcp={connections.setSelectedMcp}
      quickConnect={connections.quickConnect}
      connectMcp={connections.connectMcp}
      authorizeMcp={connections.authorizeMcp}
      logoutMcpAuth={connections.logoutMcpAuth}
      removeMcp={connections.removeMcp}
    />
  );
}
