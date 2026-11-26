import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DenClient } from "@/app/lib/den";

import type { SessionExtensions } from "@/react-app/kernel/session-extensions";
import { t } from "@/i18n";

import { AgentStandingChat } from "./agent-standing-chat";
import { standingChatFeature, standingChatMode, type StandingChatFeature } from "./agent-chat-mode";
import { agentChatsInScope, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentGreeting } from "./agent-greeting";
import { AgentHeaderTitle } from "./agent-header";
import { AgentPanel } from "./agent-panel";
import { AgentProposalCard } from "./agent-proposal-card";
import { AgentSidebarSection } from "./agent-sidebar-section";
import { AgentTranscriptFooter } from "./agent-transcript-footer";
import { AgentTranscriptFrame } from "./agent-transcript-frame";
import type { AgentScope, AgentsRuntime } from "./agents-runtime";
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

export function agentFeatureSnapshotKey(scope: AgentScope | null) {
  return ["den", "personal-agent-features", scope?.denBaseUrl, scope?.organizationId, scope?.principal];
}

export function useStandingChatFeature(scope: AgentScope | null, client: DenClient | null): StandingChatFeature {
  const snapshot = useQuery({
    queryKey: agentFeatureSnapshotKey(scope),
    queryFn: () => {
      if (!scope || !client) throw new Error("Organization is not ready");
      return client.getOrgFeatures(scope.organizationId);
    },
    enabled: Boolean(scope && client),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
  return standingChatFeature(scope && client && snapshot.isSuccess ? snapshot.data : undefined);
}

export function usePersonalAgentSessionExtensions(runtime: AgentsRuntime | null, feature: StandingChatFeature): SessionExtensions {
  const chats = useAgentChatStore((state) => state.chats);
  const agents = useAgentListQuery(runtime, true).data;
  return useMemo(() => {
    const renderStandingChat = (sessionId: string) => {
      const mode = standingChatMode(chats, runtime, sessionId, feature);
      return mode === "workspace" ? null : <AgentStandingChat key={sessionId} sessionId={sessionId} locked={mode === "locked"} />;
    };
    if (!runtime) {
      return { ...COMPONENTS, renderStandingChat, proposalCards: false, ownedSessionIds: NO_SESSION_IDS, hiddenSidebarSessionIds: NO_SESSION_IDS, composerPlaceholders: NO_PLACEHOLDERS };
    }
    const owned = agentChatsInScope(chats, runtime);
    const listed = agents ? new Set(agents.filter((item) => item.agent.state === "active").map((item) => item.agent.id)) : null;
    return {
      ...COMPONENTS,
      renderStandingChat,
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
  }, [agents, chats, feature, runtime]);
}
