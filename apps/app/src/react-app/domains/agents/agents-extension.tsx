import { useMemo } from "react";

import type { SessionExtensions } from "@/react-app/kernel/session-extensions";
import { t } from "@/i18n";

import { agentChatsInScope, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentGreeting } from "./agent-greeting";
import { AgentHeaderTitle } from "./agent-header";
import { AgentPanel } from "./agent-panel";
import { AgentProposalCard } from "./agent-proposal-card";
import { AgentSidebarSection } from "./agent-sidebar-section";
import { AgentTranscriptFooter } from "./agent-transcript-footer";
import { AgentTranscriptFrame } from "./agent-transcript-frame";
import type { AgentsRuntime } from "./agents-runtime";
import { useAgentListQuery } from "./use-agents";

const NO_SESSION_IDS: ReadonlySet<string> = new Set();
const NO_PLACEHOLDERS: ReadonlyMap<string, string> = new Map();

const COMPONENTS = {
  SidebarSection: AgentSidebarSection,
  HeaderTitle: AgentHeaderTitle,
  Greeting: AgentGreeting,
  ProposalCard: AgentProposalCard,
  TranscriptFrame: AgentTranscriptFrame,
  TranscriptFooter: AgentTranscriptFooter,
  Panel: AgentPanel,
};

export function usePersonalAgentSessionExtensions(runtime: AgentsRuntime | null): SessionExtensions {
  const chats = useAgentChatStore((state) => state.chats);
  const agents = useAgentListQuery(runtime, true).data;
  return useMemo(() => {
    if (!runtime) {
      return { ...COMPONENTS, proposalCards: false, ownedSessionIds: NO_SESSION_IDS, hiddenSidebarSessionIds: NO_SESSION_IDS, composerPlaceholders: NO_PLACEHOLDERS };
    }
    const owned = agentChatsInScope(chats, runtime);
    const listed = agents ? new Set(agents.filter((item) => item.agent.state === "active").map((item) => item.agent.id)) : null;
    return {
      ...COMPONENTS,
      proposalCards: true,
      ownedSessionIds: new Set(owned.map((chat) => chat.sessionId)),
      hiddenSidebarSessionIds: new Set(owned
        .filter((chat) => chat.agentId === null || listed === null || listed.has(chat.agentId))
        .map((chat) => chat.sessionId)),
      composerPlaceholders: new Map(owned.map((chat) => [
        chat.sessionId,
        isStandingChat(chat)
          ? t("agents.placeholder_message", { name: chat.agentName ?? t("agents.new") })
          : chat.asked ? t("agents.placeholder_answer") : t("agents.placeholder_new"),
      ])),
    };
  }, [agents, chats, runtime]);
}
