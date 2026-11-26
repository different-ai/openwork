import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

import { AgentCanUse } from "./agent-can-use";
import { agentChatFor, agentChatKey, useAgentChatStore } from "./agent-chat-store";
import { AgentFace } from "./agent-face";
import { useAgentsRuntime } from "./agents-runtime";
import { useAgentDetail } from "./use-agents";

export const AGENT_PANEL_ID = "personal-agent-panel";

export function AgentHeaderTitle(props: { sessionId: string | null; children: ReactNode }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  const panelKey = chat ? agentChatKey(chat, chat.sessionId) : null;
  const panelOpen = useAgentChatStore((state) => panelKey !== null && state.panel?.chatKey === panelKey);
  const agent = useAgentDetail(runtime, chat?.agentId);
  if (!chat || !runtime) return props.children;
  const name = agent?.agent.name ?? chat.agentName ?? t("agents.new");
  return (
    <div data-session-centered-title data-session-title-panel-open={Boolean(agent && panelOpen)} className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-dls-text max-lg:min-h-11">
      <h1 data-agent-header={chat.agentId ? undefined : "new"} className="flex min-w-0 items-center gap-2 max-lg:max-w-32">
        {!agent ? <>
          <AgentFace name={chat.agentName} />
          <span className="truncate">{name}</span>
        </> : <>
          <span className="flex min-w-0 items-center gap-2 lg:hidden"><AgentFace name={name} /><span className="truncate">{name}</span></span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-agent-header={agent.agent.id}
            aria-expanded={panelOpen}
            aria-controls={panelOpen ? AGENT_PANEL_ID : undefined}
            aria-label={t("agents.panel_open", { name })}
            className="titlebar-no-drag hidden h-7 min-w-0 shrink gap-2 rounded-full bg-dls-hover px-1.5 pe-2 text-[13px] font-medium text-dls-text lg:inline-flex"
            onClick={() => useAgentChatStore.getState().setPanel(panelOpen ? null : panelKey)}
          >
            <AgentFace name={name} />
            <span className="truncate">{name}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 text-dls-secondary" />
          </Button>
        </>}
      </h1>
      {chat.agentId && <AgentCanUse runtime={runtime} agentId={chat.agentId} placement="header"
        panelId={agent && panelOpen ? AGENT_PANEL_ID : undefined}
        onOpen={() => useAgentChatStore.getState().setPanel(panelKey, "settings")} />}
    </div>
  );
}
