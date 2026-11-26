import { useContext, type ReactNode } from "react";

import { t } from "@/i18n";
import { TextComposerSlot, type ComposerQuestion } from "@/react-app/kernel/text-composer-slot";

import { agentChatFor, agentChatKey, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentToolDecision, canDecideAgentToolRequest, isVisibleAgentRequest } from "./agent-tool-request";
import { useAgentsRuntime } from "./agents-runtime";
import { agentRunQueueMessage, isActiveRun, useAgentActions, useAgentDetail, useAgentRequestsQuery, useAgentRunsQuery } from "./use-agents";

export type AgentChatDockProps = {
  sessionId: string;
  name: string;
  draft: string;
  onDraftChange: (draft: string) => void;
  onSend: () => void | Promise<void>;
  disabled: boolean;
  sending: boolean;
  question?: ComposerQuestion;
  notice?: ReactNode;
  onStop?: () => void | Promise<void>;
};

const MESSAGE_LIMIT = 16_000;

export function AgentChatDock({ sessionId, name, draft, onDraftChange, onSend, disabled, sending, question, notice, onStop }: AgentChatDockProps) {
  const TextComposer = useContext(TextComposerSlot);
  const tooLong = draft.trim().length > MESSAGE_LIMIT;
  return (
    <div data-agent-chat-dock className="mx-auto w-full max-w-[800px] shrink-0 px-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 max-lg:px-3 lg:px-8">
      {notice}
      {TextComposer && <TextComposer
        label={t("agents.placeholder_message", { name })}
        draft={draft}
        onDraftChange={onDraftChange}
        onSend={onSend}
        disabled={disabled || tooLong}
        sending={sending}
        question={question}
        sendLabel={t(sending ? "agents.chat_sending" : "agents.chat_send")}
        onStop={onStop}
        status={tooLong ? t("agents.chat_message_too_long") : undefined}
        topAccessory={<AgentDockApproval sessionId={sessionId} />}
      />}
    </div>
  );
}

function AgentDockApproval({ sessionId }: { sessionId: string }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, sessionId));
  const agent = useAgentDetail(runtime, chat?.agentId);
  const agentId = chat && isStandingChat(chat) && agent ? agent.agent.id : null;
  const active = agent?.routines.some((routine) => isActiveRun(routine.latestRun)) ?? false;
  const requests = useAgentRequestsQuery(runtime, agentId, Boolean(agent?.openRequestCount));
  const runs = useAgentRunsQuery(runtime, agentId, active);
  const actions = useAgentActions(runtime);
  if (!runtime || !chat || !agent || !agentId) return null;
  const request = (requests.data ?? []).filter((entry) => canDecideAgentToolRequest(entry) && isVisibleAgentRequest(agent, entry))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
  const runQueueMessage = agentRunQueueMessage(actions.runNow.error);
  return <>
    {request && <div data-composer-interaction="permission" className="px-4">
      <AgentToolDecision key={agentChatKey(runtime, request.id)} runtime={runtime} agent={agent} request={request} onAllowed={!request.runId ? undefined : () => {
        if (!request.requestedByCaller) return;
        const previousRun = runs.data?.find((run) => run.id === request.runId);
        const firstRoutine = agent.routines.find((routine) => routine.state !== "archived");
        const routineId = previousRun?.automationId ?? (request.runId === chat.firstRunId ? chat.routineId : null) ?? firstRoutine?.id;
        actions.runNow.mutate({ agentId, routineId });
      }} />
    </div>}
    {runQueueMessage && <p role="status" className="px-4 pt-2 text-xs text-dls-secondary">{runQueueMessage}</p>}
  </>;
}
