import { t } from "@/i18n";

import { AgentChangeRequest } from "./agent-change-request";
import { AgentToolReceipt, canDecideAgentToolRequest, isVisibleAgentRequest } from "./agent-tool-request";
import { agentChatFor, agentChatKey, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentRunResult, AgentScheduledRunSummary } from "./agent-run-result";
import { useAgentsRuntime } from "./agents-runtime";
import { agentRunSource, isActiveRun, useAgentDetail, useAgentRequestsQuery, useAgentRunsQuery } from "./use-agents";

export function AgentTranscriptFooter(props: { sessionId: string; scoped?: boolean }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  const agent = useAgentDetail(runtime, chat?.agentId);
  const agentId = chat && isStandingChat(chat) && agent ? agent.agent.id : null;
  const active = agent?.routines.some((routine) => isActiveRun(routine.latestRun)) ?? false;
  const runsQuery = useAgentRunsQuery(runtime, agentId, active);
  const requestsQuery = useAgentRequestsQuery(runtime, agentId, Boolean(agent?.openRequestCount));
  if (!runtime || !chat || !agent || !agentId) return null;
  const visibleRuns = (runsQuery.data ?? []).filter((run) => props.scoped || run.id !== chat.firstRunId).sort((a, b) => a.createdAt - b.createdAt).slice(-5);
  const requests = (requestsQuery.data ?? []).filter((request) => !canDecideAgentToolRequest(request) && isVisibleAgentRequest(agent, request))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  if (!visibleRuns.length && !requests.length && !runsQuery.isError && !requestsQuery.isError) return null;

  return (
    <div data-agent-runs className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-2 pb-4 md:px-10">
      {visibleRuns.map((run) => {
        const routineName = agent.routines.find((routine) => routine.id === run.automationId)?.name ?? agent.agent.name;
        return agentRunSource(agent.role, run) === "summary"
          ? <AgentScheduledRunSummary key={run.id} run={run} routineName={routineName} />
          : <AgentRunResult key={run.id} runtime={runtime} agentId={agentId} runId={run.id} active={isActiveRun(run)} routineName={routineName} />;
      })}
      {runsQuery.isError && <p className="text-xs text-dls-secondary">{t("agents.runs_unavailable")}</p>}
      {requests.map((request) => request.kind === "tool" ? (
        <AgentToolReceipt key={agentChatKey(runtime, request.id)} agent={agent} request={request} />
      ) : <AgentChangeRequest key={agentChatKey(runtime, request.id)} runtime={runtime} agent={agent} request={request} />)}
      {requestsQuery.isError && <p className="text-xs text-dls-secondary">{t("agents.requests_unavailable")}</p>}
    </div>
  );
}
