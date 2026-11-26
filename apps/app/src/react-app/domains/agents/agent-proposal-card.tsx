import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { toast } from "sonner";

import { parsePersonalAgentProposal } from "@/components/tools/openwork-automation-proposal";
import type { SessionProposalCardProps } from "@/react-app/kernel/session-extensions";
import { currentLocale, t } from "@/i18n";

import { agentChatFor, agentChatKey, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentChoices } from "./agent-choices";
import { AgentFace } from "./agent-face";
import { AgentRunResult } from "./agent-run-result";
import { agentProposalKey, startAgentFromProposal, startOnce } from "./agent-start";
import { scheduleInWords, scheduleZone } from "./agent-words";
import { useAgentsRuntime } from "./agents-runtime";
import { agentListKey, agentRequestsKey, agentsQueryRoot, pendingRoutineMessage, useAgentDetail } from "./use-agents";

export function AgentProposalCard(props: SessionProposalCardProps) {
  const runtime = useAgentsRuntime();
  const queryClient = useQueryClient();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  const agent = useAgentDetail(runtime, chat?.agentId);
  const proposal = parsePersonalAgentProposal(props.part.output);
  const start = useMutation({
    mutationKey: [...agentsQueryRoot(runtime), "start", props.sessionId, props.part.toolCallId],
    mutationFn: async () => {
      if (!runtime || !proposal) throw new Error(t("agents.start_sign_in"));
      return startOnce(agentChatKey(runtime, props.sessionId), async () => {
        const store = useAgentChatStore.getState();
        store.open({ denBaseUrl: runtime.denBaseUrl, organizationId: runtime.organizationId, principal: runtime.principal, workspaceId: props.workspaceId, sessionId: props.sessionId, proposalId: props.part.toolCallId });
        const saved = agentChatFor(useAgentChatStore.getState().chats, runtime, props.sessionId);
        const progress = await startAgentFromProposal({
          api: {
            createAgent: (input) => runtime.client.createPersonalAgent(runtime.organizationId, input),
            createRoutine: (agentId, input) => runtime.client.createPersonalAgentRoutine(runtime.organizationId, agentId, input),
            runNow: (agentId, routineId) => runtime.client.runPersonalAgentNow(runtime.organizationId, agentId, { routineId }),
          },
          proposal,
          idempotencyKey: await agentProposalKey(props.sessionId, props.part.toolCallId),
          linkChat: (agentId) => runtime.client.setPersonalAgentChat(runtime.organizationId, agentId, { workspaceId: props.workspaceId, sessionId: props.sessionId }),
          saved: {
            agentId: saved?.agentId ?? null,
            agentName: saved?.agentName ?? null,
            routineId: saved?.routineId ?? null,
            routineName: saved?.routineName ?? null,
            firstRunId: saved?.firstRunId ?? null,
          },
          save: (next) => useAgentChatStore.getState().save(runtime, props.sessionId, next),
        });
        if (progress.agentName) runtime.renameSession(props.workspaceId, props.sessionId, progress.agentName);
        return progress;
      });
    },
    onSuccess: async ({ pendingChange }) => {
      if (!pendingChange) return;
      toast.success(pendingRoutineMessage(agent?.owner));
      await queryClient.invalidateQueries({ queryKey: agentRequestsKey(runtime, pendingChange.request.agentId) });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: agentListKey(runtime) }),
  });

  if (!proposal) return null;
  const mine = chat?.proposalId === props.part.toolCallId;
  if (!mine && ((chat && isStandingChat(chat)) || !props.latest || props.readOnly)) return null;

  if (mine && start.data?.pendingChange) return <p role="status" className="text-xs text-dls-secondary">{pendingRoutineMessage(agent?.owner)}</p>;

  const failed = start.error instanceof Error ? start.error.message : null;
  if (mine && chat?.routineId && runtime) {
    return (
      <div data-agent-started={chat.agentId ?? ""} className="flex flex-col gap-4">
        <p className="flex items-center justify-center gap-1.5 text-xs text-dls-secondary">
          <Clock aria-hidden="true" className="size-3.5" />
          {t("agents.created_routine", { name: chat.routineName ?? proposal.routine.name })}
        </p>
        <p data-agent-line className="text-[13px] leading-relaxed text-foreground">
          {chat.firstRunId ? t("agents.you_are_set") : t("agents.you_are_set_waiting")}
        </p>
        {chat.firstRunId && chat.agentId
          ? <AgentRunResult runtime={runtime} agentId={chat.agentId} runId={chat.firstRunId} routineName={chat.routineName ?? proposal.routine.name} />
          : (
            <AgentChoices
              description={failed}
              choices={[{
                id: "retry",
                label: start.isPending ? t("agents.start_starting") : t("agents.start_retry"),
                disabled: start.isPending || props.readOnly,
                onSelect: () => start.mutate(),
              }]}
            />
          )}
      </div>
    );
  }

  const zone = scheduleZone(proposal.routine.schedule);
  return (
    <div data-agent-proposal={props.part.toolCallId} className="flex flex-col gap-3">
      <p className="flex min-w-0 items-center gap-2 text-[13px] text-dls-secondary">
        <AgentFace name={proposal.name} />
        <span className="truncate font-medium text-dls-text">{proposal.name}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{[scheduleInWords(proposal.routine.schedule), zone].filter(Boolean).join(", ")}</span>
      </p>
      <p data-agent-proposal-connections className="wrap-anywhere text-xs text-dls-secondary">
        {t("agents.start_connections", {
          connections: proposal.connectorNames?.length
            ? new Intl.ListFormat(currentLocale()).format(proposal.connectorNames)
            : t("agents.start_connections_none"),
        })}
      </p>
      <AgentChoices
        title={t("agents.start_question")}
        description={failed ?? (runtime ? null : t("agents.start_sign_in"))}
        choices={[
          {
            id: "start",
            label: start.isPending ? t("agents.start_starting") : failed ? t("agents.start_retry") : t("agents.start_yes"),
            disabled: start.isPending || !runtime || props.readOnly,
            onSelect: () => start.mutate(),
          },
          { id: "cadence", label: t("agents.start_cadence"), disabled: start.isPending || props.readOnly, onSelect: () => props.setPrompt(t("agents.start_cadence_prompt")) },
          { id: "else", label: t("agents.start_else"), muted: true, disabled: start.isPending || props.readOnly, onSelect: () => props.setPrompt("") },
        ]}
      />
    </div>
  );
}
