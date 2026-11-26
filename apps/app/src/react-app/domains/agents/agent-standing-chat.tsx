import { useMemo, useRef, useState } from "react";
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
import { agentThreadMessages } from "./agent-thread-messages";
import { AgentTranscriptFooter } from "./agent-transcript-footer";
import { useAgentsRuntime, type AgentsRuntime } from "./agents-runtime";
import { agentsQueryRoot, useAgentDetail } from "./use-agents";

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
  const paused = Boolean(agent?.agent.pausedAt);
  const sendInProgress = useRef(false);
  const [text, setText] = useState("");
  const queryKey = [...agentsQueryRoot(runtime), "standing-thread", agentId];
  const thread = useQuery({
    queryKey,
    queryFn: ({ signal }) => runtime.client.getPersonalAgentThread(runtime.organizationId, agentId, signal),
    retry: false,
    refetchInterval: (query) => query.state.data?.turns.some((turn) => turn.status === "running") ? 1_500 : 15_000,
  });
  const send = useMutation({
    mutationFn: ({ input }: ThreadSend) => runtime.client.sendPersonalAgentThreadMessage(runtime.organizationId, agentId, input),
    retry: false,
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: ({ turn }) => {
      setText("");
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
  const running = thread.data?.turns.some((turn) => turn.status === "running") ?? false;
  const submitted = send.variables?.input;
  const confirmed = submitted && thread.data?.turns.some((turn) => turn.clientMessageId === submitted.clientMessageId);
  const pending = send.isPending && !confirmed ? send.variables : undefined;
  const uncertain = send.isError && !confirmed;
  const messages = useMemo(() => agentThreadMessages(thread.data?.turns ?? [], pending ? { ...pending.input, createdAt: pending.createdAt } : null), [thread.data?.turns, pending]);
  const draft = confirmed && send.isError && text.trim() === submitted?.message ? "" : text;
  const disabled = thread.isPending || thread.isError || running || paused;
  function submit() {
    const message = draft.trim();
    if (disabled || send.isPending || sendInProgress.current || !message || message.length > 16_000) return;
    sendInProgress.current = true;
    send.mutate({
      input: { message, clientMessageId: uncertain && submitted?.message === message ? submitted.clientMessageId : crypto.randomUUID() },
      createdAt: Date.now(),
    });
  }

  return <div data-agent-thread className="flex h-full min-h-0 flex-col">
    <div role="log" aria-label={t("agents.chat_transcript")} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto px-3 sm:px-5">
      <div className="w-full shrink-0 py-4">
        {thread.isPending ? <div role="status" aria-label={t("agents.chat_loading")} className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-2 md:px-10">
          <Skeleton className="h-9 w-40 self-end rounded-2xl" />
          <Skeleton className="h-4 w-56 max-w-full" />
        </div> : !thread.isError && messages.length === 0 ?
          <p className="mx-auto w-full max-w-3xl px-2 text-sm text-dls-secondary md:px-10">{t("agents.chat_empty", { name: displayName })}</p> : null}
        <RemoteTranscriptView threadKey={threadKey} messages={messages} running={running || Boolean(pending)}
          showThinking={local.prefs.showThinking} developerMode={false} />
        <AgentTranscriptFooter sessionId={sessionId} scoped />
      </div>
    </div>
    <AgentChatDock sessionId={sessionId} name={displayName} draft={draft} onDraftChange={setText}
      onSend={submit} disabled={disabled} sending={send.isPending}
      notice={<>
        {thread.isError && <div role="alert" className="mb-2 flex items-center justify-between gap-3 px-2 text-sm text-dls-secondary">
          {t("agents.chat_load_failed")}
          <Button variant="ghost" size="sm" type="button" onClick={() => void thread.refetch()}>{t("common.retry")}</Button>
        </div>}
        {uncertain && <p role="alert" className="mb-2 px-2 text-sm text-dls-secondary">{t("agents.chat_send_failed")}</p>}
        {paused && <p role="status" className="mb-2 px-2 text-sm text-dls-secondary">{t("agents.panel_admin_paused")}</p>}
      </>}
    />
  </div>;
}
