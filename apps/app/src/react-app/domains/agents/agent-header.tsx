import { ChevronDown, Cloud } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { SessionHeaderTitleProps } from "@/react-app/kernel/session-extensions";

import { agentChatFor, agentChatKey, useAgentChatStore } from "./agent-chat-store";
import { AgentFace } from "./agent-face";
import { useAgentsRuntime } from "./agents-runtime";
import { useAgentDetail } from "./use-agents";

export const AGENT_PANEL_ID = "personal-agent-panel";

export function AgentHeaderTitle({ sessionId, layout, children }: SessionHeaderTitleProps) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, sessionId));
  const panelKey = chat ? agentChatKey(chat, chat.sessionId) : null;
  const panelOpen = useAgentChatStore((state) => panelKey !== null && state.panel?.chatKey === panelKey);
  const agent = useAgentDetail(runtime, chat?.agentId);
  if (!chat || !runtime) return children;
  const name = agent?.agent.name ?? chat.agentName ?? t("agents.new");
  const compact = layout === "compact";
  const title = (
    <h1 data-agent-header={chat.agentId ? undefined : "new"} className="flex min-w-0 items-center gap-2 max-lg:max-w-32 max-lg:shrink-0">
      {!agent ? <>
        <AgentFace name={chat.agentName} />
        <span className="truncate">{name}</span>
      </> : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-agent-header={agent.agent.id}
          aria-expanded={panelOpen}
          aria-controls={panelOpen ? AGENT_PANEL_ID : undefined}
          aria-label={t("agents.panel_open", { name })}
          className="titlebar-no-drag h-7 min-w-0 shrink gap-2 rounded-full bg-dls-hover px-1.5 pe-2 text-[13px] font-medium text-dls-text"
          onClick={() => useAgentChatStore.getState().setPanel(panelOpen ? null : panelKey)}
        >
          <AgentFace name={name} />
          <span className="truncate">{name}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-dls-secondary" />
        </Button>
      )}
    </h1>
  );
  return (
    <div
      data-session-centered-title={compact ? undefined : true}
      data-session-title-panel-open={compact ? undefined : Boolean(agent && panelOpen)}
      className={cn("flex min-w-0 items-center gap-1 text-[13px] font-medium text-dls-text", !compact && "max-lg:min-h-11")}
    >
      {compact ? (
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 titlebar-no-drag">
          <span className="shrink-0 px-1 font-normal text-dls-secondary">{t("agents.section")}</span>
          <span aria-hidden="true" className="text-dls-secondary/50">/</span>
          {title}
          {chat.agentId && <AgentCloudLocation />}
        </nav>
      ) : title}
    </div>
  );
}

function AgentCloudLocation() {
  const label = t("agents.runs_in_cloud");
  return (
    <Tooltip>
      <TooltipTrigger render={
        <span role="img" aria-label={label} tabIndex={0} className="ms-1 inline-flex size-6 shrink-0 items-center justify-center text-dls-secondary">
          <Cloud aria-hidden="true" className="size-4" strokeWidth={1.5} />
        </span>
      } />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
