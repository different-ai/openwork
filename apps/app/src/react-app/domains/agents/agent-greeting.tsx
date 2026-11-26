import type { SessionGreetingProps } from "@/react-app/kernel/session-extensions";
import { t } from "@/i18n";

import { agentChatFor, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentChoices } from "./agent-choices";
import { useAgentsRuntime } from "./agents-runtime";

export function AgentGreeting(props: SessionGreetingProps) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  if (!chat) return null;
  if (isStandingChat(chat)) {
    return (
      <div data-agent-greeting="standing" className="mx-auto flex w-full max-w-3xl flex-col px-2 pb-5 pt-6 md:px-10">
        <p data-agent-line className="text-[13px] leading-relaxed text-foreground">{t("agents.standing_greeting")}</p>
      </div>
    );
  }
  if (chat.agentId) return null;
  return (
    <div data-agent-greeting className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-2 pt-6 md:px-10">
      <p data-agent-line className="text-[13px] leading-relaxed text-foreground">{t("agents.greeting")}</p>
      <div>
        <AgentChoices
          choices={[
            { id: "watch", label: t("agents.starter_watch"), onSelect: () => props.setPrompt(t("agents.starter_watch_prompt")) },
            { id: "morning", label: t("agents.starter_morning"), onSelect: () => props.setPrompt(t("agents.starter_morning_prompt")) },
            { id: "follow", label: t("agents.starter_follow"), onSelect: () => props.setPrompt(t("agents.starter_follow_prompt")) },
            { id: "else", label: t("agents.starter_else"), muted: true, onSelect: () => props.setPrompt("") },
          ]}
        />
      </div>
    </div>
  );
}
