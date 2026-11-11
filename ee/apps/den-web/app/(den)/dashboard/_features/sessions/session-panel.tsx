"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Square } from "lucide-react";
import type { RemoteSessionAnswerInput, RemoteSessionPending, RemoteSessionTranscriptMessage } from "@openwork/types/automations";
import type { MemberSession, MemberSessionComputer, MemberSessionState } from "@openwork/types/den/remote-sessions";
import { DenBadge } from "../../../_components/ui/badge";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTextarea } from "../../../_components/ui/textarea";
import { StatusDot, TimeAgo, hairline, secondaryText } from "../computers/computer-parts";
import { IDLE_CARD_STATE, PendingCards, type PendingCardState } from "./session-pending-cards";
import {
  answerRemoteSession,
  readRemoteSession,
  remoteSessionErrorCode,
  sendRemoteSessionPrompt,
  sessionViewQueryKey,
  stopRemoteSession,
  useSessionView,
  type SessionLocation,
} from "./sessions-data";
import {
  appendSentMessage,
  mergeEarlierPage,
  pendingItemsOf,
  sessionStateBadge,
  sessionTitle,
  toolStatusLabel,
  transcriptSteps,
  type SessionView,
} from "./sessions-model";

/** Den's wording for these is written for agents; here it is said to the person. Other failures show Den's message. */
const ERROR_LINES: Record<string, string> = {
  desktop_update_required: "Update OpenWork on that computer to follow this session from here.",
  unknown_session: "This session is no longer on that computer.",
  stale_request: "This was already answered.",
};

export function sessionErrorLine(error: unknown, fallback: string): string {
  const known = ERROR_LINES[remoteSessionErrorCode(error) ?? ""];
  if (known) return known;
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function offlineLine(computerLabel: string | null): string {
  return `${computerLabel?.trim() || "This computer"} is offline. This resumes when it reconnects.`;
}

function messageTime(message: RemoteSessionTranscriptMessage): string | null {
  return message.createdAt === null ? null : new Date(message.createdAt).toISOString();
}

/**
 * The conversation, read-only. Every word comes from another computer and is
 * rendered as text: no markdown, no links, nothing a message could run.
 */
export function SessionMessages({ messages, now }: { messages: readonly RemoteSessionTranscriptMessage[]; now: number }) {
  if (messages.length === 0) return <p className={`py-4 ${secondaryText}`}>No messages yet.</p>;
  return <ol>
    {messages.map((message) => {
      const iso = messageTime(message);
      return <li key={message.id} className={`border-b ${hairline} py-3 last:border-b-0`} data-role={message.role}>
        <p className={`flex items-center justify-between gap-3 text-xs ${secondaryText}`}>
          <span className="font-medium">{message.role === "user" ? "You" : "OpenWork"}</span>
          {iso ? <TimeAgo iso={iso} now={now} className="shrink-0 tabular-nums" /> : null}
        </p>
        <div className="mt-1 space-y-1.5">
          {transcriptSteps(message).map((step) => step.kind === "text"
            ? <p key={step.key} className="whitespace-pre-wrap break-words">{step.text}</p>
            : <p key={step.key} className={`flex min-w-0 items-baseline gap-2 text-xs ${secondaryText}`} data-step="tool">
              <span className="min-w-0 truncate">{step.name}</span>
              {toolStatusLabel(step.status) ? <span className="shrink-0">{toolStatusLabel(step.status)}</span> : null}
            </p>)}
          {message.truncated ? <p className={`text-xs ${secondaryText}`}>Shortened here. The full message is on that computer.</p> : null}
          {message.error ? <p className="break-words text-[var(--ow-danger)]">{message.error.message}</p> : null}
        </div>
      </li>;
    })}
  </ol>;
}

/** Keeps the newest message in view, and the reader's place when an earlier page is added in front. */
function Conversation({ messages, now, earlier }: {
  messages: readonly RemoteSessionTranscriptMessage[];
  now: number;
  earlier: SessionPanelViewProps["earlier"];
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = useRef<{ firstId: string | undefined; lastId: string | undefined; height: number } | null>(null);
  const nearBottom = useRef(true);
  const firstId = messages[0]?.id;
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const previous = last.current;
    if (!previous || (nearBottom.current && previous.firstId === firstId)) element.scrollTop = element.scrollHeight;
    else if (previous.firstId !== firstId && previous.lastId === lastId) element.scrollTop += element.scrollHeight - previous.height;
    last.current = { firstId, lastId, height: element.scrollHeight };
  }, [messages, firstId, lastId]);
  return <div ref={scroller} role="log" aria-label="Conversation" tabIndex={0}
    onScroll={(event) => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}
    className={`mt-4 max-h-[60vh] overflow-y-auto border-y ${hairline} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-text-secondary)]`}>
    {earlier.available ? <div className={`flex flex-wrap items-center gap-3 border-b ${hairline} py-2`}>
      <DenButton variant="secondary" size="sm" loading={earlier.loading} onClick={earlier.onLoad}>Load earlier</DenButton>
      {earlier.error ? <p role="alert" className="min-w-0 break-words">{earlier.error}</p> : null}
    </div> : null}
    <SessionMessages messages={messages} now={now} />
  </div>;
}

export type SessionPanelViewProps = {
  title: string;
  computerLabel: string | null;
  workspaceName: string | null;
  state: MemberSessionState;
  /** The computer is not connected: nothing here can reach it until it is. */
  offline: boolean;
  view: SessionView | undefined;
  loading: boolean;
  /** Why the newest read failed, when it is not simply that the computer is offline. */
  error: string | null;
  retrying: boolean;
  onRetry: () => void;
  earlier: { available: boolean; loading: boolean; error: string | null; onLoad: () => void };
  pending: {
    items: readonly RemoteSessionPending[];
    stateFor: (requestId: string) => PendingCardState;
    onAnswer: (answer: RemoteSessionAnswerInput) => void;
    onRetry: (requestId: string) => void;
  };
  /** One quiet line about the last answer, e.g. that it was already answered. */
  notice: string | null;
  followUp: { draft: string; sending: boolean; error: string | null; onDraft: (draft: string) => void; onSend: () => void };
  stop: { stopping: boolean; error: string | null; onStop: () => void };
  onClose: () => void;
  now: number;
};

/** One session: what was said, what it waits on, and a box to follow up. Everything is given; nothing is fetched here. */
export function SessionPanelView({ title, computerLabel, workspaceName, state, offline, view, loading, error, retrying, onRetry, earlier, pending, notice, followUp, stop, onClose, now }: SessionPanelViewProps) {
  const badge = sessionStateBadge(state);
  const running = view?.read.status === "running";
  const canSend = !offline && !followUp.sending && followUp.draft.trim().length > 0;
  function sendOnChord(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !canSend) return;
    event.preventDefault();
    followUp.onSend();
  }
  return <section className="min-w-0 max-w-3xl text-[13px] text-[color:var(--dls-text-primary)]" data-testid="session-panel" aria-busy={loading}>
    <DenButton variant="ghost" size="inline" icon={ArrowLeft} onClick={onClose}>Back to My Sessions</DenButton>
    <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="break-words text-base font-medium">{title}</h2>
        <p className={`mt-0.5 flex flex-wrap gap-x-3 text-xs ${secondaryText}`}>
          {computerLabel ? <span className="break-words">{computerLabel}</span> : null}
          {workspaceName ? <span className="break-words">{workspaceName}</span> : null}
        </p>
      </div>
      {badge ? <DenBadge tone={badge.tone} size="sm">{badge.label}</DenBadge> : null}
    </div>

    {offline ? <p role="status" className={`mt-3 flex items-center gap-2 ${secondaryText}`} data-testid="session-offline">
      <StatusDot tone="neutral" />{offlineLine(computerLabel)}
    </p> : null}
    {error ? <div role="alert" className="mt-3 flex flex-wrap items-center gap-3">
      <p className="min-w-0 break-words">{error}{view ? " Showing what was last read." : ""}</p>
      <DenButton variant="secondary" size="sm" loading={retrying} onClick={onRetry}>Try again</DenButton>
    </div> : null}

    {view ? <>
      <Conversation messages={view.messages} now={now} earlier={earlier} />
      {view.read.status === "error" && view.read.lastError ? <p className="mt-3 break-words text-[var(--ow-danger)]">{view.read.lastError.message}</p> : null}
    </> : loading ? <div aria-hidden="true" className={`mt-4 space-y-3 border-y ${hairline} py-4`}>
      <DenSkeleton className="h-4 w-2/3" /><DenSkeleton className="h-4 w-1/2" /><DenSkeleton className="h-4 w-3/5" />
    </div> : null}

    {notice ? <p role="status" className={`mt-3 ${secondaryText}`}>{notice}</p> : null}
    {pending.items.length ? <div className="mt-4"><PendingCards {...pending} /></div> : null}

    <form className="mt-4" aria-label="Follow up" onSubmit={(event) => { event.preventDefault(); if (canSend) followUp.onSend(); }}>
      <DenTextarea aria-label="Follow-up message" placeholder="Send a follow-up" rows={3} maxLength={100_000}
        value={followUp.draft} disabled={followUp.sending} onChange={(event) => followUp.onDraft(event.target.value)} onKeyDown={sendOnChord} />
      {followUp.error ? <p role="alert" className="mt-2 break-words text-[var(--ow-danger)]">{followUp.error}</p> : null}
      {stop.error ? <p role="alert" className="mt-2 break-words text-[var(--ow-danger)]">{stop.error}</p> : null}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {running ? <DenButton type="button" variant="secondary" size="sm" icon={Square} loading={stop.stopping} disabled={offline} onClick={stop.onStop}>Stop</DenButton> : null}
        <DenButton type="submit" size="sm" loading={followUp.sending} disabled={!canSend}>Send</DenButton>
      </div>
    </form>
  </section>;
}

const LIVE_STATES: readonly string[] = ["starting", "running", "waiting"];

type CardRecord = PendingCardState & { last: RemoteSessionAnswerInput | null };

/**
 * A session the member can reach, through the command that reached it. Reads,
 * follow-ups, stop and answers all go to that session's own computer; while it
 * is offline the last content stays and the page says so.
 */
export function SessionPanel({ orgId, memberId, session, computer, onClose }: {
  orgId: string;
  memberId: string;
  session: MemberSession & { commandId: string; sessionId: string; workspaceId: string };
  computer: MemberSessionComputer | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const location: SessionLocation = { sessionId: session.sessionId, workspaceId: session.workspaceId };
  const queryKey = sessionViewQueryKey(orgId, memberId, session.commandId);
  const online = computer?.online ?? true;
  const [cards, setCards] = useState<Record<string, CardRecord>>({});
  const [answered, setAnswered] = useState<readonly string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);

  const cached = queryClient.getQueryData<SessionView>(queryKey);
  const live = online && (LIVE_STATES.includes(session.state) || LIVE_STATES.includes(cached?.read.status ?? ""));
  const query = useSessionView(orgId, memberId, session.commandId, location, live);
  const view = query.data;
  const refetch = query.refetch;

  // The list is read every few seconds anyway: when it shows this session moved, or its computer came back, read again.
  const mounted = useRef(false);
  const pendingRequestId = session.pending?.requestId ?? "";
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    void refetch({ cancelRefetch: false });
  }, [refetch, session.state, session.updatedAt, pendingRequestId, online]);

  async function answer(input: RemoteSessionAnswerInput) {
    setNotice(null);
    setCards((current) => ({ ...current, [input.requestId]: { sending: input, error: null, last: input } }));
    try {
      await answerRemoteSession(orgId, location, input);
      setAnswered((current) => [...current, input.requestId]);
    } catch (failure) {
      if (remoteSessionErrorCode(failure) !== "stale_request") {
        setCards((current) => ({ ...current, [input.requestId]: { sending: null, error: sessionErrorLine(failure, "Couldn't send your answer. Try again."), last: input } }));
        return;
      }
      // Answered on the computer or from another device meanwhile: nothing to retry.
      setAnswered((current) => [...current, input.requestId]);
      setNotice(ERROR_LINES.stale_request);
    }
    void refetch();
  }

  async function send() {
    const prompt = draft.trim();
    if (!prompt || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const { messageId } = await sendRemoteSessionPrompt(orgId, location, prompt);
      setDraft("");
      // The member's message stays on screen while the computer works on it.
      if (messageId) queryClient.setQueryData<SessionView>(queryKey, (current) => current ? appendSentMessage(current, { id: messageId, text: prompt, createdAt: Date.now() }) : current);
      void refetch();
    } catch (failure) {
      setSendError(sessionErrorLine(failure, "Couldn't send your message. Try again."));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopRemoteSession(orgId, location);
      void refetch();
    } catch (failure) {
      setStopError(sessionErrorLine(failure, "Couldn't stop this session. Try again."));
    } finally {
      setStopping(false);
    }
  }

  async function loadEarlier() {
    const cursor = view?.earlierCursor;
    if (!cursor || loadingEarlier) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    try {
      const page = await readRemoteSession(orgId, location, cursor);
      queryClient.setQueryData<SessionView>(queryKey, (current) => current ? mergeEarlierPage(current, page) : current);
    } catch (failure) {
      setEarlierError(sessionErrorLine(failure, "Couldn't load earlier messages. Try again."));
    } finally {
      setLoadingEarlier(false);
    }
  }

  const offlineError = remoteSessionErrorCode(query.error) === "desktop_offline";
  const items = view ? pendingItemsOf(view.read).filter((item) => !answered.includes(item.requestId)) : [];
  return <SessionPanelView
    title={sessionTitle(view?.read.title ?? session.title)}
    computerLabel={session.computerLabel ?? computer?.label ?? null}
    workspaceName={session.workspaceName}
    state={view?.read.status ?? session.state}
    offline={!online || offlineError}
    view={view}
    loading={query.isPending}
    error={query.error && !offlineError ? sessionErrorLine(query.error, "Couldn't load this session. Try again.") : null}
    retrying={query.isFetching}
    onRetry={() => void refetch()}
    earlier={{ available: Boolean(view?.earlierCursor), loading: loadingEarlier, error: earlierError, onLoad: () => void loadEarlier() }}
    pending={{
      items,
      stateFor: (requestId) => cards[requestId] ?? IDLE_CARD_STATE,
      onAnswer: (input) => void answer(input),
      onRetry: (requestId) => { const last = cards[requestId]?.last; if (last) void answer(last); },
    }}
    notice={notice}
    followUp={{ draft, sending, error: sendError, onDraft: setDraft, onSend: () => void send() }}
    stop={{ stopping, error: stopError, onStop: () => void stop() }}
    onClose={onClose}
    now={Date.now()}
  />;
}
