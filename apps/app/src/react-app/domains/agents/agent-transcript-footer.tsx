import { t } from "@/i18n";
import { cn } from "@/lib/utils";

import { AgentChangeRequest } from "./agent-change-request";
import { AgentToolReceipt, canDecideAgentToolRequest, isVisibleAgentRequest } from "./agent-tool-request";
import { agentChatFor, agentChatKey, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AGENT_ROW_INSET, AgentRunEntry } from "./agent-run-result";
import { useAgentsRuntime } from "./agents-runtime";
import { isActiveRun, useAgentDetail, useAgentRequestsQuery, useAgentRunsQuery } from "./use-agents";

export function AgentTranscriptFooter(props: { sessionId: string }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  const agent = useAgentDetail(runtime, chat?.agentId);
  const agentId = chat && isStandingChat(chat) && agent ? agent.agent.id : null;
  const active = agent?.routines.some((routine) => isActiveRun(routine.latestRun)) ?? false;
  const runsQuery = useAgentRunsQuery(runtime, agentId, active);
  const requestsQuery = useAgentRequestsQuery(runtime, agentId, Boolean(agent?.openRequestCount));
  if (!runtime || !chat || !agent || !agentId) return null;
  const visibleRuns = (runsQuery.data ?? []).filter((run) => run.id !== chat.firstRunId).sort((a, b) => a.createdAt - b.createdAt).slice(-5);
  const requests = (requestsQuery.data ?? []).filter((request) => !canDecideAgentToolRequest(request) && isVisibleAgentRequest(agent, request))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!visibleRuns.length && !requests.length && !runsQuery.isError && !requestsQuery.isError) return null;

  return (
    <div data-agent-runs className="flex w-full flex-col gap-5 pb-4">
      {visibleRuns.map((run) => <AgentRunEntry key={run.id} runtime={runtime} agentId={agentId} role={agent.role} run={run}
        routineName={agent.routines.find((routine) => routine.id === run.automationId)?.name ?? agent.agent.name} />)}
      {runsQuery.isError && <p className={cn(AGENT_ROW_INSET, "text-xs text-dls-secondary")}>{t("agents.runs_unavailable")}</p>}
      {requests.map((request) => <div key={agentChatKey(runtime, request.id)} className={AGENT_ROW_INSET}>
        {request.kind === "tool" ? <AgentToolReceipt agent={agent} request={request} />
          : <AgentChangeRequest runtime={runtime} agent={agent} request={request} />}
      </div>)}
      {requestsQuery.isError && <p className={cn(AGENT_ROW_INSET, "text-xs text-dls-secondary")}>{t("agents.requests_unavailable")}</p>}
    </div>
  );
}
