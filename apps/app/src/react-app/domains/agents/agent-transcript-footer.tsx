import { t } from "@/i18n";

import { AgentAskCard } from "./agent-ask-card";
import { AgentChangeRequest } from "./agent-change-request";
import { agentChatFor, agentChatKey, isStandingChat, useAgentChatStore } from "./agent-chat-store";
import { AgentRunResult, AgentScheduledRunSummary } from "./agent-run-result";
import { useAgentsRuntime } from "./agents-runtime";
import { agentRunQueueMessage, agentRunSource, isActiveRun, useAgentActions, useAgentDetail, useAgentRequestsQuery, useAgentRunsQuery } from "./use-agents";

export function AgentTranscriptFooter(props: { sessionId: string; scoped?: boolean }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, props.sessionId));
  const agent = useAgentDetail(runtime, chat?.agentId);
  const agentId = chat && isStandingChat(chat) && agent ? agent.agent.id : null;
  const active = agent?.routines.some((routine) => isActiveRun(routine.latestRun)) ?? false;
  const runsQuery = useAgentRunsQuery(runtime, agentId, active);
  const requestsQuery = useAgentRequestsQuery(runtime, agentId, Boolean(agent?.openRequestCount));
  const actions = useAgentActions(runtime);
  if (!runtime || !chat || !agent || !agentId) return null;
  const runs = runsQuery.data ?? [];
  const routines = agent.routines.filter((routine) => routine.state !== "archived");
  const visibleRuns = runs.filter((run) => props.scoped || run.id !== chat.firstRunId).sort((a, b) => a.createdAt - b.createdAt).slice(-5);
  const requests = (requestsQuery.data ?? []).filter((request) => {
    if (request.kind !== "tool" || request.status !== "pending" || !request.connectionId || !request.toolName) return true;
    return agent.revision.toolPolicy.tools[request.connectionId]?.[request.toolName] !== "block";
  }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const runQueueMessage = actions.runNow.variables?.agentId === agentId ? agentRunQueueMessage(actions.runNow.error) : null;
  if (!visibleRuns.length && !requests.length && !runsQuery.isError && !requestsQuery.isError && !runQueueMessage) return null;

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
        <AgentAskCard key={agentChatKey(runtime, request.id)} runtime={runtime} agent={agent} request={request} onAllowed={!request.runId ? undefined : () => {
          if (!request.requestedByCaller) return;
          const previousRun = runs.find((run) => run.id === request.runId);
          const routineId = previousRun?.automationId ?? (request.runId && request.runId === chat.firstRunId ? chat.routineId : null) ?? routines[0]?.id;
          actions.runNow.mutate({ agentId, routineId });
        }} />
      ) : <AgentChangeRequest key={agentChatKey(runtime, request.id)} runtime={runtime} agent={agent} request={request} />)}
      {runQueueMessage && <p role="status" className="text-xs text-dls-secondary">{runQueueMessage}</p>}
      {requestsQuery.isError && <p className="text-xs text-dls-secondary">{t("agents.requests_unavailable")}</p>}
    </div>
  );
}
