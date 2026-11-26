import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, LockKeyhole } from "lucide-react";
import type { PersonalAgentStandingChat, SendPersonalAgentChatMessage } from "@openwork/types/den/personal-agents";

import { Button } from "@/components/ui/button";
import { Message, MessageContent } from "@/components/ui/message";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";

import { agentChatFor, agentChatKey, useAgentChatStore } from "./agent-chat-store";
import { AgentTranscriptFooter } from "./agent-transcript-footer";
import { useAgentsRuntime, type AgentsRuntime } from "./agents-runtime";
import { agentsQueryRoot } from "./use-agents";

export function AgentStandingChat({ sessionId, locked }: { sessionId: string; locked: boolean }) {
  const runtime = useAgentsRuntime();
  const chat = useAgentChatStore((state) => agentChatFor(state.chats, runtime, sessionId));
  if (locked || !runtime || !chat?.agentId) {
    return <div role="status" data-agent-thread-locked className="flex h-full items-center justify-center gap-2 px-5 text-sm text-dls-secondary">
      <LockKeyhole aria-hidden="true" className="size-4 shrink-0" />
      {t("agents.chat_unverified")}
    </div>;
  }
  return <StandingThread key={agentChatKey(runtime, chat.agentId)} runtime={runtime} agentId={chat.agentId} sessionId={sessionId}
    name={chat.agentName ?? t("agents.new")} />;
}

function StandingThread({ runtime, agentId, sessionId, name }: { runtime: AgentsRuntime; agentId: string; sessionId: string; name: string }) {
  const queryClient = useQueryClient();
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
    mutationFn: (input: SendPersonalAgentChatMessage) => runtime.client.sendPersonalAgentThreadMessage(runtime.organizationId, agentId, input),
    retry: false,
    onMutate: () => queryClient.cancelQueries({ queryKey }),
    onSuccess: ({ turn }) => {
      setText("");
      queryClient.setQueryData<PersonalAgentStandingChat>(queryKey, (data) => ({
        turns: [...(data?.turns.filter((entry) => entry.id !== turn.id) ?? []), turn],
      }));
    },
    onSettled: () => {
      sendInProgress.current = false;
      void queryClient.invalidateQueries({ queryKey: agentsQueryRoot(runtime) });
    },
  });
  const turns = thread.data?.turns ?? [];
  const running = turns.some((turn) => turn.status === "running");
  const canSend = !thread.isError && !thread.isPending && !running && !send.isPending && text.trim().length > 0;
  const label = t("agents.placeholder_message", { name });
  const submitted = send.variables;
  const confirmed = submitted && turns.some((turn) => turn.clientMessageId === submitted.clientMessageId);
  const pending = send.isPending && !confirmed ? submitted : null;
  const uncertain = send.isError && !confirmed;
  function submit() {
    if (!canSend || sendInProgress.current) return;
    const message = text.trim();
    if (confirmed && send.isError && message === submitted?.message) {
      setText("");
      send.reset();
      return;
    }
    sendInProgress.current = true;
    send.mutate({ message, clientMessageId: uncertain && submitted?.message === message ? submitted.clientMessageId : crypto.randomUUID() });
  }

  return <div data-agent-thread className="flex h-full min-h-0 flex-col">
    <div role="log" aria-label={t("agents.chat_transcript")} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto px-3 sm:px-5">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 py-4">
        {thread.isPending && <p role="status" className="text-center text-sm text-dls-secondary">{t("agents.chat_loading")}</p>}
        {!thread.isPending && !thread.isError && !turns.length && !pending && <p className="px-2 text-sm text-dls-secondary md:px-10">{t("agents.chat_empty", { name })}</p>}
        {turns.map((turn) => <div key={turn.id} className="flex flex-col gap-4 px-2 md:px-10">
          <UserLine text={turn.message} />
          {turn.reply && <Message data-message-role="assistant">
            <MessageContent markdown className="w-full min-w-0 bg-transparent p-0">{turn.reply}</MessageContent>
          </Message>}
          {turn.status === "failed" && <p role="status" className="text-sm text-dls-secondary">{t("agents.chat_reply_failed")}</p>}
        </div>)}
        {pending && <div className="px-2 md:px-10"><UserLine text={pending.message} /></div>}
        {(running || pending) && <p role="status" className="px-2 text-sm text-dls-secondary md:px-10">{t("agents.chat_replying", { name })}</p>}
        <AgentTranscriptFooter sessionId={sessionId} scoped />
      </div>
    </div>
    <form className="mx-auto w-full max-w-[720px] px-4 pb-4 pt-2 sm:px-5" onSubmit={(event) => { event.preventDefault(); submit(); }}>
      {thread.isError && <div role="alert" className="mb-2 flex items-center justify-between gap-3 px-2 text-sm text-dls-secondary">
        {t("agents.chat_load_failed")}
        <Button variant="ghost" size="sm" type="button" onClick={() => void thread.refetch()}>{t("common.retry")}</Button>
      </div>}
      {uncertain && <p role="alert" className="mb-2 px-2 text-sm text-dls-secondary">{t("agents.chat_send_failed")}</p>}
      <div className="relative">
        <Textarea aria-label={label} placeholder={label} value={confirmed && send.isError && text === submitted?.message ? "" : text}
          maxLength={16_000} readOnly={send.isPending} className="max-h-48 rounded-2xl pe-14"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }} />
        <Button type="submit" size="icon-sm" disabled={!canSend || (confirmed && send.isError && text === submitted?.message)} aria-label={t("agents.chat_send")}
          className="absolute bottom-2 end-2 rounded-full"><ArrowUp aria-hidden="true" className="size-4" /></Button>
      </div>
    </form>
  </div>;
}

function UserLine({ text }: { text: string }) {
  return <Message data-message-role="user" className="justify-end">
    <MessageContent className="max-w-[85%] whitespace-pre-wrap rounded-3xl bg-muted px-4 py-2.5">{text}</MessageContent>
  </Message>;
}
