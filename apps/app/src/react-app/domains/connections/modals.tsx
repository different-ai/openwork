/** @jsxImportSource react */
import type { Client } from "../../../app/types";
import type { Language } from "../../../i18n";
import type { McpDirectoryInfo } from "../../../app/constants";

import { McpAuthModal } from "./mcp-auth-modal";

export type ConnectionsModalsState = {
  mcpAuthModalOpen: boolean;
  mcpAuthEntry: McpDirectoryInfo | null;
  mcpAuthNeedsReload: boolean;
};

export type ConnectionsModalsProps = {
  client: Client | null;
  projectDir: string;
  language: Language;
  reloadBlocked: boolean;
  activeSessions: Array<{ id: string; title: string }>;
  isRemoteWorkspace: boolean;
  onForceStopSession: (sessionID: string) => void | Promise<void>;
  onReloadEngine: () => void | Promise<void>;
  modalState: ConnectionsModalsState;
  onCloseMcpAuthModal: () => void;
  onCompleteMcpAuthModal: () => void | Promise<void>;
};

export default function ConnectionsModals(props: ConnectionsModalsProps) {
  return (
    <McpAuthModal
      open={props.modalState.mcpAuthModalOpen}
      client={props.client}
      entry={props.modalState.mcpAuthEntry}
      projectDir={props.projectDir}
      language={props.language}
      reloadRequired={props.modalState.mcpAuthNeedsReload}
      reloadBlocked={props.reloadBlocked}
      activeSessions={props.activeSessions}
      isRemoteWorkspace={props.isRemoteWorkspace}
      onForceStopSession={props.onForceStopSession}
      onClose={props.onCloseMcpAuthModal}
      onComplete={props.onCompleteMcpAuthModal}
      onReloadEngine={props.onReloadEngine}
    />
  );
}
