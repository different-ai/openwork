import { useCallback, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LockKeyhole } from "lucide-react";
import type { PersonalAgentStandingChat, SendPersonalAgentChatMessage } from "@openwork/types/den/personal-agents";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { RemoteTranscriptView } from "@/react-app/design-system/readonly-transcript-view";
import { useLocal } from "@/react-app/kernel/local-provider";

import { AgentChatDock } from "./agent-chat-dock";
import { agentChatFor, agentChatKey, useAgentChatStore } from "./agent-chat-store";
import { AGENT_ROW_INSET, AgentRunEntry } from "./agent-run-result";
import { agentThreadTimeline } from "./agent-thread-messages";
import { AgentChangeRequest } from "./agent-change-request";
import { agentConnectorIdentities } from "./agent-connection-logo";
import { AgentToolReceipt, canDecideAgentToolRequest, isVisibleAgentRequest } from "./agent-tool-request";
import { useAgentsRuntime, type AgentsRuntime } from "./agents-runtime";
import { useAgentToolsQuery } from "./use-agent-permissions";
import { agentsQueryRoot, isActiveRun, useAgentDetail, useAgentRequestsQuery, useAgentRunsQuery } from "./use-agents";

type ThreadSend = { input: SendPersonalAgentChatMessage; createdAt: number };

export function AgentStandingChat({ sessionId, locked }: { sessionId: string; locked: boolean }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, sessionId));
  if (locked || !runtime || !chat?.agentId) {
    return <div role="status" data-agent-thread-locked className="flex h-full items-center justify-center gap-2 px-5 text-sm text-dls-secondary">
      <LockKeyhole aria-hidden="true" className="size-4 shrink-0" />
      {t("agents.chat_unverified")}
    </div>;
  }
  const threadKey = agentChatKey(runtime, chat.agentId);
  return <StandingThread key={threadKey} threadKey={threadKey} runtime={runtime} agentId={chat.agentId} sessionId={sessionId}
    name={chat.agentName ?? t("agents.new")} />;
}

function StandingThread({ runtime, agentId, sessionId, name, threadKey }: { runtime: AgentsRuntime; agentId: string; sessionId: string; name: string; threadKey: string }) {
  const queryClient = useQueryClient();
  const local = useLocal();
  const agent = useAgentDetail(runtime, agentId);
  const displayName = agent?.agent.name ?? name;
  const catalog = useAgentToolsQuery(runtime, agentId).data;
  const connectorIdentities = useMemo(() => agentConnectorIdentities(catalog), [catalog]);
  const paused = Boolean(agent?.agent.pausedAt);
  const sendInProgress = useRef(false);
  const [text, setText] = useState("");
  const [queued, setQueued] = useState<ThreadSend | null>(null);
  const held = useRef<ThreadSend | null>(null);
  const hold = (message: ThreadSend | null) => {
    held.current = message;
    setQueued(message);
  };
  const queryKey = [...agentsQueryRoot(runtime), "standing-thread", agentId];
  const send = useMutation({
    mutationFn: ({ input }: ThreadSend) => runtime.client.sendPersonalAgentThreadMessage(runtime.organizationId, agentId, input),
    retry: false,
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onError: (_error, { input }) => setText((current) => current.trim() ? current : input.message),
    onSuccess: ({ turn }) => {
      setText((current) => current.trim() === turn.message ? "" : current);
      queryClient.setQueryData<PersonalAgentStandingChat>(queryKey, (data) => {
        if (data?.turns.some((entry) => entry.clientMessageId === turn.clientMessageId)) return data;
        return { turns: [...(data?.turns ?? []), turn] };
      });
    },
    onSettled: () => {
      sendInProgress.current = false;
      void queryClient.invalidateQueries({ queryKey: agentsQueryRoot(runtime) });
    },
  });
  const thread = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      const data = await runtime.client.getPersonalAgentThread(runtime.organizationId, agentId, signal);
      const waiting = held.current;
      if (waiting && !paused && !sendInProgress.current && !data.turns.some((turn) => turn.status === "running")) {
        sendInProgress.current = true;
        hold(null);
        setTimeout(() => send.mutate(waiting), 0);
      }
      return data;
    },
    retry: false,
    refetchInterval: (query) => query.state.data?.turns.some((turn) => turn.status === "running") ? 1_500 : 15_000,
  });
  const running = thread.data?.turns.some((turn) => turn.status === "running") ?? false;
  const submitted = send.variables?.input;
  const confirmed = submitted && thread.data?.turns.some((turn) => turn.clientMessageId === submitted.clientMessageId);
  const pending = send.isPending && !confirmed ? send.variables : queued ?? undefined;
  const uncertain = send.isError && !confirmed;
  const runsActive = agent?.routines.some((routine) => isActiveRun(routine.latestRun)) ?? false;
  const runs = useAgentRunsQuery(runtime, agent ? agentId : null, runsActive);
  const recentRuns = useMemo(() => [...runs.data ?? []].sort((a, b) => a.createdAt - b.createdAt).slice(-5), [runs.data]);
  const requests = useAgentRequestsQuery(runtime, agent ? agentId : null, Boolean(agent?.openRequestCount), true, running);
  const answeredRequests = useMemo(() => agent ? (requests.data ?? []).filter((request) => !canDecideAgentToolRequest(request) && isVisibleAgentRequest(agent, request)) : [],
    [requests.data, agent]);
  const timeline = useMemo(() => agentThreadTimeline(thread.data?.turns ?? [], recentRuns,
    pending ? { ...pending.input, createdAt: pending.createdAt } : null, answeredRequests), [thread.data?.turns, recentRuns, pending, answeredRequests]);
  const lastChat = timeline.findLast((item) => item.kind === "chat");
  const pinned = useRef(true);
  const keepAtBottom = useCallback((inner: HTMLDivElement | null) => {
    const el = inner?.parentElement;
    if (!inner || !el) return;
    const stick = () => { if (pinned.current) el.scrollTop = el.scrollHeight; };
    stick();
    const observer = new ResizeObserver(stick);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);
  const draft = confirmed && send.isError && text.trim() === submitted?.message ? "" : text;
  const disabled = thread.isPending || thread.isError || paused;
  const busy = running || send.isPending;
  function submit() {
    const message = draft.trim();
    if (disabled || !message) return;
    pinned.current = true;
    if (busy || queued) {
      const joined = queued ? `${queued.input.message}\n\n${message}` : message;
      if (joined.length > 16_000) return;
      hold({ input: { message: joined, clientMessageId: queued?.input.clientMessageId ?? crypto.randomUUID() }, createdAt: queued?.createdAt ?? Date.now() });
      setText("");
      return;
    }
    if (sendInProgress.current || message.length > 16_000) return;
    sendInProgress.current = true;
    send.mutate({
      input: { message, clientMessageId: uncertain && submitted?.message === message ? submitted.clientMessageId : crypto.randomUUID() },
      createdAt: Date.now(),
    });
    setText("");
  }

  return <div data-agent-thread className="flex h-full min-h-0 flex-col">
    <div role="log" aria-label={t("agents.chat_transcript")} className="min-h-0 flex-1 overflow-y-auto px-3 sm:px-5"
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}>
      <div ref={keepAtBottom} className="flex w-full flex-col gap-5 py-4">
        {thread.isPending ? <div role="status" aria-label={t("agents.chat_loading")} className={`${AGENT_ROW_INSET} flex flex-col gap-4`}>
          <Skeleton className="h-9 w-40 self-end rounded-2xl" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div> : !thread.isError && timeline.length === 0 ?
          <div className={AGENT_ROW_INSET}><p className="w-fit max-w-[92%] rounded-3xl border border-dls-border bg-dls-surface px-4 py-2.5 text-sm leading-6 text-dls-text">{agent?.routines.length === 0 ? t("agents.greeting") : t("agents.chat_empty", { name: displayName })}</p></div> : null}
        {timeline.map((item, index) => item.kind === "request"
          ? agent && <div key={item.key} className={AGENT_ROW_INSET}>
            {item.request.kind === "tool" ? <AgentToolReceipt agent={agent} request={item.request} answered={index < timeline.length - 1} />
              : <AgentChangeRequest runtime={runtime} agent={agent} request={item.request} />}
          </div>
          : item.kind === "chat"
          ? <RemoteTranscriptView key={item.key} threadKey={`${threadKey}:${item.key}`} messages={item.messages}
            running={item === lastChat && (running || Boolean(pending))} showThinking={local.prefs.showThinking} developerMode={false} assistantBubbles connectorIdentities={connectorIdentities} />
          : agent && <AgentRunEntry key={item.key} runtime={runtime} agentId={agentId} role={agent.role} run={item.run}
            routineName={agent.routines.find((routine) => routine.id === item.run.automationId)?.name ?? displayName} />)}
        {requests.isError && <p className={`${AGENT_ROW_INSET} text-xs text-dls-secondary`}>{t("agents.requests_unavailable")}</p>}
      </div>
    </div>
    <AgentChatDock sessionId={sessionId} name={displayName} draft={draft} onDraftChange={setText}
      onSend={submit} disabled={disabled} sending={false}
      notice={<>
        {thread.isError && <div role="alert" className="mb-2 flex items-center justify-between gap-3 px-2 text-sm text-dls-secondary">
          {t("agents.chat_load_failed")}
          <Button variant="ghost" size="sm" type="button" onClick={() => void thread.refetch()}>{t("common.retry")}</Button>
        </div>}
        {uncertain && <p role="alert" className="mb-2 px-2 text-sm text-dls-secondary">{t("agents.chat_send_failed")}</p>}
        {queued && <p role="status" data-agent-queued className="mb-2 px-2 text-sm text-dls-secondary">{t("agents.chat_queued", { name: displayName })}</p>}
        {paused && <p role="status" className="mb-2 px-2 text-sm text-dls-secondary">{t("agents.panel_admin_paused")}</p>}
      </>}
    />
  </div>;
}
