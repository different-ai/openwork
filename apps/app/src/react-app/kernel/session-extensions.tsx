import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { DynamicToolUIPart } from "ai";

export type SessionProposalCardProps = {
  sessionId: string;
  workspaceId: string;
  part: DynamicToolUIPart;
  latest: boolean;
  readOnly: boolean;
  setPrompt: (text: string) => void;
};

export type SessionGreetingProps = {
  sessionId: string;
  setPrompt: (text: string) => void;
};

export type SessionExtensions = {
  SidebarSection: ComponentType;
  HeaderTitle: ComponentType<{ sessionId: string | null; children: ReactNode }>;
  Greeting: ComponentType<SessionGreetingProps>;
  ProposalCard: ComponentType<SessionProposalCardProps>;
  TranscriptFrame: ComponentType<{ sessionId: string; children: ReactNode }>;
  TranscriptFooter: ComponentType<{ sessionId: string }>;
  renderChatApprovals?: (completedAt: number) => ReactNode;
  Panel: ComponentType<{ sessionId: string | null }>;
  proposalCards: boolean;
  ownedSessionIds: ReadonlySet<string>;
  hiddenSidebarSessionIds: ReadonlySet<string>;
  composerPlaceholders: ReadonlyMap<string, string>;
};

const NO_SESSION_IDS: ReadonlySet<string> = new Set();
const NO_PLACEHOLDERS: ReadonlyMap<string, string> = new Map();

function Nothing() {
  return null;
}

function Passthrough({ children }: { children: ReactNode }) {
  return children;
}

const NO_SESSION_EXTENSIONS: SessionExtensions = {
  SidebarSection: Nothing,
  HeaderTitle: Passthrough,
  Greeting: Nothing,
  ProposalCard: Nothing,
  TranscriptFrame: Passthrough,
  TranscriptFooter: Nothing,
  Panel: Nothing,
  proposalCards: false,
  ownedSessionIds: NO_SESSION_IDS,
  hiddenSidebarSessionIds: NO_SESSION_IDS,
  composerPlaceholders: NO_PLACEHOLDERS,
};

const SessionExtensionsContext = createContext<SessionExtensions>(NO_SESSION_EXTENSIONS);

export const SessionExtensionsProvider = SessionExtensionsContext.Provider;

export function useSessionExtensions(): SessionExtensions {
  return useContext(SessionExtensionsContext);
}
