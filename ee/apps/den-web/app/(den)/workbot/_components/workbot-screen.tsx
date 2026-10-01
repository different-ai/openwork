"use client";

import { Dialog } from "@base-ui/react/dialog";
import { ArrowUp, CalendarClock, ChevronRight, FileText, Lock, Square, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CloudBrowserView } from "../../_components/cloud-browser-view";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { useMcpConnections } from "../../dashboard/_components/mcp-connections-data";
import { useOrgDashboard } from "../../dashboard/_providers/org-dashboard-provider";
import {
  useSendWorkbotMessage,
  useStopWorkbot,
  useWorkbotDraft,
  useWorkbotThread,
  type WorkbotAutomation,
  type WorkbotTurn,
} from "./workbot-data";
import { dayLabel, durationLabel, fileTitle, initials, nextRunLabel, scheduleLabel, timeLabel } from "./workbot-format";
import { WorkbotMarkdown } from "./workbot-markdown";

type Pending = { id: string; text: string; sentAt: number; failed: string | null };

type TimelineItem =
  | { kind: "turn"; at: number; turn: WorkbotTurn }
  | { kind: "pending"; at: number; pending: Pending }
  | { kind: "result"; at: number; automation: WorkbotAutomation; run: WorkbotAutomation["runs"][number] };

function newMessageId() {
  return crypto.randomUUID().replaceAll("-", "");
}

export function WorkbotScreen() {
  const { user } = useDenFlow();
  const { orgId } = useOrgDashboard();
  const [pending, setPending] = useState<Pending[]>([]);
  const thread = useWorkbotThread({ awaiting: pending.some((entry) => !entry.failed) });
  const send = useSendWorkbotMessage();
  const stop = useStopWorkbot();
  const data = thread.data?.available ? thread.data : null;

  // A sent message stays on screen as written until the conversation shows it.
  useEffect(() => {
    if (!data) return;
    const known = new Set(data.turns.map((turn) => turn.id));
    setPending((current) => (current.some((entry) => known.has(entry.id)) ? current.filter((entry) => !known.has(entry.id)) : current));
  }, [data]);

  const submit = (text: string, id = newMessageId()) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPending((current) => [...current.filter((entry) => entry.id !== id), { id, text: trimmed, sentAt: Date.now(), failed: null }]);
    send.mutate({ id, text: trimmed }, {
      onError: (error) => setPending((current) => current.map((entry) => (entry.id === id ? { ...entry, failed: error.message } : entry))),
    });
  };

  if (thread.isPending) return <WorkbotSkeleton />;
  if (thread.isError && !thread.data) {
    return (
      <Centered>
        <p className="text-[14px] text-[var(--dls-text-primary)]">Couldn&apos;t load your conversation.</p>
        <button type="button" onClick={() => void thread.refetch()} className="mt-3 rounded-lg px-3 py-1.5 text-[13px] font-medium text-[var(--dls-text-primary)] hover:bg-[var(--dls-hover)] focus-visible:outline-2 focus-visible:outline-[var(--dls-accent)]">
          Try again
        </button>
      </Centered>
    );
  }
  if (!thread.data?.available) {
    const notEnabled = thread.data?.reason === "workbot_not_enabled";
    return (
      <Centered>
        <Lock size={16} strokeWidth={1.5} className="text-[var(--dls-text-secondary)]" aria-hidden />
        <p className="mt-3 text-[14px] text-[var(--dls-text-primary)]">
          {notEnabled ? "Workbot isn't on for your organization yet." : "Workbot is unavailable right now."}
        </p>
        <p className="mt-1 text-[13px] text-[var(--dls-text-secondary)]">
          {notEnabled ? "An admin can turn it on." : "Try again in a few minutes."}
        </p>
      </Centered>
    );
  }

  const busy = thread.data.status === "busy" || pending.some((entry) => !entry.failed);
  return (
    <div className="flex h-dvh flex-col bg-[var(--dls-app-bg)]">
      <WorkbotHeader name={thread.data.name} userName={user?.name ?? null} orgId={orgId} />
      <Conversation
        thread={thread.data}
        pending={pending}
        firstName={user?.name?.trim().split(/\s+/)[0] ?? null}
        onSuggestion={(text) => submit(text)}
        onRetry={(entry) => submit(entry.text, entry.id)}
        onRetryTurn={(turn) => submit(turn.text)}
        onContinue={(text) => submit(text)}
      />
      <Composer name={thread.data.name} busy={busy} stopping={stop.isPending} onSend={(text) => submit(text)} onStop={() => stop.mutate()} />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh flex-col items-center justify-center bg-[var(--dls-app-bg)] px-6 text-center">{children}</div>;
}

function WorkbotSkeleton() {
  return (
    <div className="flex h-dvh flex-col bg-[var(--dls-app-bg)]" aria-busy="true">
      <div className="flex h-14 items-center gap-3 border-b border-[var(--dls-border)] bg-[var(--dls-surface)] px-5">
        <span className="h-8 w-8 rounded-lg bg-[var(--dls-hover)]" />
        <span className="h-4 w-24 rounded bg-[var(--dls-hover)]" />
      </div>
      <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-end gap-3 px-5 pb-6">
        <span className="h-4 w-2/3 rounded bg-[var(--dls-hover)]" />
        <span className="h-4 w-1/2 rounded bg-[var(--dls-hover)]" />
      </div>
      <div className="mx-auto w-full max-w-[720px] px-5 pb-5">
        <div className="h-[92px] rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)]" />
      </div>
    </div>
  );
}

function WorkbotHeader({ name, userName, orgId }: { name: string; userName: string | null; orgId: string | null }) {
  const connections = useMcpConnections("usable");
  const apps = useMemo(
    () => (connections.data ?? []).filter((connection) => connection.connected && (connection.connectedForMe || connection.credentialMode !== "per_member")).map((connection) => connection.name),
    [connections.data],
  );
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--dls-border)] bg-[var(--dls-surface)] px-4 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--dls-accent)] text-[13px] font-semibold text-white">
          {name.charAt(0).toUpperCase()}
        </span>
        <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--dls-text-primary)]">{name}</h1>
        {orgId && apps.length > 0 ? (
          <span className="hidden truncate rounded-full bg-[var(--dls-hover)] px-2.5 py-1 text-[12px] text-[var(--dls-text-secondary)] sm:inline">
            {apps.slice(0, 3).join(", ")}{apps.length > 3 ? ` +${apps.length - 3}` : ""}
          </span>
        ) : null}
      </div>
      <Link
        href="/dashboard"
        aria-label="Your dashboard"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--dls-hover)] text-[12px] font-semibold text-[var(--dls-text-primary)] hover:bg-[var(--dls-active)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-accent)]"
      >
        {initials(userName)}
      </Link>
    </header>
  );
}

function timeline(thread: { turns: WorkbotTurn[]; automations: WorkbotAutomation[] }, pending: Pending[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...thread.turns.map((turn): TimelineItem => ({ kind: "turn", at: turn.sentAt ?? 0, turn })),
    ...thread.automations.flatMap((automation) => automation.runs.flatMap((run): TimelineItem[] => (
      run.finishedAt === null ? [] : [{ kind: "result", at: run.finishedAt, automation, run }]
    ))),
    ...pending.map((entry): TimelineItem => ({ kind: "pending", at: entry.sentAt, pending: entry })),
  ];
  return items.sort((left, right) => left.at - right.at);
}

function Conversation(props: {
  thread: { name: string; organizationName: string; turns: WorkbotTurn[]; automations: WorkbotAutomation[] };
  pending: Pending[];
  firstName: string | null;
  onSuggestion: (text: string) => void;
  onRetry: (entry: Pending) => void;
  onRetryTurn: (turn: WorkbotTurn) => void;
  onContinue: (text: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const items = timeline(props.thread, props.pending);
  const latestTurnId = props.thread.turns.at(-1)?.id ?? null;
  const automations = new Map(props.thread.automations.map((automation) => [automation.id, automation]));
  const [openDraft, setOpenDraft] = useState<string | null>(null);

  // Follow new content only while the person is already at the bottom.
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  });

  return (
    <div
      ref={scroller}
      className="flex-1 overflow-y-auto"
      onScroll={(event) => {
        const node = event.currentTarget;
        pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[720px] flex-col px-4 pb-6 pt-8 sm:px-5">
        {items.length === 0 ? (
          <FirstOpen name={props.thread.name} organizationName={props.thread.organizationName} firstName={props.firstName} onSuggestion={props.onSuggestion} />
        ) : (
          <ol className="flex flex-col gap-7" aria-label="Conversation">
            {items.map((item, index) => {
              const previous = items[index - 1];
              const day = item.at ? dayLabel(item.at) : null;
              const showDay = day && (!previous || !previous.at || dayLabel(previous.at) !== day);
              return (
                <li key={`${item.kind}:${item.kind === "turn" ? item.turn.id : item.kind === "pending" ? item.pending.id : item.run.id}`} className="flex flex-col gap-7">
                  {showDay ? <p className="text-center text-[12px] text-[var(--dls-text-secondary)]">{day}</p> : null}
                  {item.kind === "turn" ? (
                    <TurnView
                      turn={item.turn}
                      name={props.thread.name}
                      latest={item.turn.id === latestTurnId}
                      onContinue={props.onContinue}
                      automations={item.turn.automationIds.flatMap((id) => automations.get(id) ?? [])}
                      onOpenDraft={setOpenDraft}
                      onRetry={() => props.onRetryTurn(item.turn)}
                    />
                  ) : item.kind === "pending" ? (
                    <PendingView entry={item.pending} onRetry={() => props.onRetry(item.pending)} />
                  ) : (
                    <ResultView automation={item.automation} run={item.run} />
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <DraftDialog path={openDraft} onClose={() => setOpenDraft(null)} />
    </div>
  );
}

function FirstOpen(props: { name: string; organizationName: string; firstName: string | null; onSuggestion: (text: string) => void }) {
  const suggestions = ["Catch me up on what I missed this week", "Which emails need a reply today?", "Every Friday at 4, remind me to send my weekly update"];
  return (
    <div className="mt-auto flex flex-col gap-5 pb-2">
      <p className="flex items-center gap-2 text-[12px] text-[var(--dls-text-secondary)]">
        <span aria-hidden className="grid h-5 w-5 place-items-center rounded-full bg-[var(--dls-hover)] text-[10px] font-semibold text-[var(--dls-text-primary)]">
          {initials(props.organizationName)}
        </span>
        {props.organizationName} set up {props.name} for you
      </p>
      <p className="max-w-[560px] text-[20px] font-semibold leading-snug tracking-[-0.02em] text-[var(--dls-text-primary)]">
        {props.firstName ? `Hi ${props.firstName}. ` : "Hi. "}What&apos;s on your plate this week?
      </p>
      <ul className="max-w-[480px] divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]">
        {suggestions.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => props.onSuggestion(suggestion)}
              className="flex h-11 w-full items-center text-left text-[14px] text-[var(--dls-text-primary)] transition-colors duration-150 hover:bg-[var(--dls-hover)] focus-visible:outline-2 focus-visible:outline-[var(--dls-accent)]"
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UserBubble({ text, muted = false }: { text: string; muted?: boolean }) {
  return (
    <p className={`ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-[var(--dls-active)] px-4 py-2.5 text-[14px] leading-[1.55] text-[var(--dls-text-primary)] ${muted ? "opacity-70" : ""}`}>
      {text}
    </p>
  );
}

function PendingView({ entry, onRetry }: { entry: Pending; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <UserBubble text={entry.text} muted={Boolean(entry.failed)} />
      {entry.failed ? (
        <p className="ml-auto flex items-center gap-2 text-[12px] text-[var(--ow-danger)]">
          {entry.failed}
          <button type="button" onClick={onRetry} className="font-medium text-[var(--dls-text-primary)] underline underline-offset-2">Send again</button>
        </p>
      ) : (
        <Working label="Reading your message" />
      )}
    </div>
  );
}

function Working({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 text-[13px] text-[var(--dls-text-secondary)]" role="status">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--dls-text-secondary)] motion-safe:animate-pulse" />
      {label}
    </p>
  );
}

function TurnView(props: {
  turn: WorkbotTurn;
  name: string;
  latest: boolean;
  onContinue: (text: string) => void;
  automations: WorkbotAutomation[];
  onOpenDraft: (path: string) => void;
  onRetry: () => void;
}) {
  const { turn } = props;
  const working = turn.status === "working" || turn.status === "queued";
  const duration = turn.sentAt && turn.finishedAt ? durationLabel(turn.finishedAt - turn.sentAt) : null;
  return (
    <div className="flex flex-col gap-3">
      <UserBubble text={turn.text} />
      <div className="flex flex-col gap-3">
        {working ? (
          <Working label={turn.activity ?? (turn.status === "queued" ? "Up next" : "Working on it")} />
        ) : turn.steps.length > 0 && duration ? (
          <details className="group">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[12px] text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)] [&::-webkit-details-marker]:hidden">
              <ChevronRight size={14} strokeWidth={1.5} aria-hidden className="transition-transform duration-150 group-open:rotate-90" />
              Worked for {duration} · {turn.steps.length} {turn.steps.length === 1 ? "step" : "steps"}
            </summary>
            <ol className="mt-2 flex flex-col gap-1.5 border-l border-[var(--dls-border)] pl-4">
              {turn.steps.map((step, index) => (
                <li key={index} className={`text-[12px] ${step.status === "error" ? "text-[var(--ow-danger)]" : "text-[var(--dls-text-secondary)]"}`}>{step.label}</li>
              ))}
            </ol>
          </details>
        ) : null}
        {turn.reply ? <WorkbotMarkdown text={turn.reply} /> : null}
        {turn.files.map((path) => (
          <Card key={path} icon={<FileText size={16} strokeWidth={1.5} aria-hidden />} title={fileTitle(path)} detail="Draft">
            <button
              type="button"
              onClick={() => props.onOpenDraft(path)}
              className="h-8 rounded-lg border border-[var(--dls-border)] px-3 text-[12px] font-medium text-[var(--dls-text-primary)] hover:bg-[var(--dls-hover)] focus-visible:outline-2 focus-visible:outline-[var(--dls-accent)]"
            >
              Open
            </button>
          </Card>
        ))}
        {props.automations.map((automation) => <AutomationCard key={automation.id} automation={automation} />)}
        {/* The live browser belongs to the latest turn only: while it works there, or while it waits for a sign-in. */}
        {props.latest && turn.browser.used && (working || turn.browser.handedOff) ? (
          <div className="max-w-[560px]">
            <CloudBrowserView
              variant="card"
              assistantName={props.name}
              siteLabel={turn.browser.site ?? undefined}
              expandHref={`/browser?${new URLSearchParams({ assistant: props.name, ...(turn.browser.site ? { site: turn.browser.site } : {}) }).toString()}`}
              onDone={() => props.onContinue("I'm signed in.")}
              onSkip={() => props.onContinue("Skip that for now.")}
            />
          </div>
        ) : null}
        {turn.status === "failed" ? (
          <p className="flex items-center gap-2 text-[13px] text-[var(--ow-danger)]">
            {turn.error}
            <button type="button" onClick={props.onRetry} className="font-medium text-[var(--dls-text-primary)] underline underline-offset-2">Try again</button>
          </p>
        ) : null}
        {turn.status === "stopped" ? <p className="text-[13px] text-[var(--dls-text-secondary)]">Stopped.</p> : null}
      </div>
    </div>
  );
}

function Card({ icon, title, detail, children }: { icon: ReactNode; title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="flex max-w-[440px] items-center gap-3 rounded-xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-3 py-2.5">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--dls-hover)] text-[var(--dls-text-primary)]">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-[var(--dls-text-primary)]">{title}</span>
        <span className="truncate text-[12px] text-[var(--dls-text-secondary)]">{detail}</span>
      </span>
      {children}
    </div>
  );
}

function AutomationCard({ automation }: { automation: WorkbotAutomation }) {
  const next = automation.state === "active" ? nextRunLabel(automation.nextDueAt) : null;
  return (
    <Card icon={<CalendarClock size={16} strokeWidth={1.5} aria-hidden />} title={automation.name} detail={scheduleLabel(automation.schedule)}>
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--dls-text-secondary)]">
        {next ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--ow-success)]" /> : null}
        {next ?? (automation.state === "needs_attention" ? "Needs attention" : "Paused")}
      </span>
    </Card>
  );
}

function ResultView({ automation, run }: { automation: WorkbotAutomation; run: WorkbotAutomation["runs"][number] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 text-[12px] text-[var(--dls-text-secondary)]">
        <CalendarClock size={14} strokeWidth={1.5} aria-hidden />
        {automation.name}
        {run.finishedAt ? <span>· {timeLabel(run.finishedAt)}</span> : null}
      </p>
      {run.status === "succeeded" && run.resultSummary ? (
        <WorkbotMarkdown text={run.resultSummary} />
      ) : (
        <p className="text-[13px] text-[var(--ow-danger)]">{run.error ?? "This run didn't finish."}</p>
      )}
    </div>
  );
}

function DraftDialog({ path, onClose }: { path: string | null; onClose: () => void }) {
  const draft = useWorkbotDraft(path);
  return (
    <Dialog.Root open={Boolean(path)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
        <Dialog.Popup className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col bg-[var(--dls-surface)] shadow-[var(--dls-shell-shadow)] outline-none">
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--dls-border)] px-5">
            <Dialog.Title className="truncate text-[15px] font-semibold text-[var(--dls-text-primary)]">{path ? fileTitle(path) : ""}</Dialog.Title>
            <Dialog.Close aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-[var(--dls-text-secondary)] hover:bg-[var(--dls-hover)] focus-visible:outline-2 focus-visible:outline-[var(--dls-accent)]">
              <X size={16} strokeWidth={1.5} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            {draft.isPending ? (
              <div className="flex flex-col gap-2" aria-busy="true">
                <span className="h-4 w-3/4 rounded bg-[var(--dls-hover)]" />
                <span className="h-4 w-2/3 rounded bg-[var(--dls-hover)]" />
              </div>
            ) : draft.isError ? (
              <p className="text-[13px] text-[var(--dls-text-secondary)]">{draft.error.message}</p>
            ) : (
              <WorkbotMarkdown text={draft.data ?? ""} />
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Composer(props: { name: string; busy: boolean; stopping: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const canSend = text.trim().length > 0;

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
  }, [text]);

  const sendNow = () => {
    if (!canSend) return;
    props.onSend(text);
    setText("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      sendNow();
    } else if (event.key === "Escape" && props.busy) {
      props.onStop();
    }
  };
  // While an answer is in progress, a typed message is still sent (it is answered next); an empty box offers Stop.
  const showStop = props.busy && !canSend;

  return (
    <div className="mx-auto w-full max-w-[720px] shrink-0 px-4 pb-4 sm:px-5 sm:pb-5">
      <div className="flex items-end gap-2 rounded-2xl border border-[var(--dls-border)] bg-[var(--dls-surface)] py-2 pl-4 pr-2 transition-colors duration-150 focus-within:border-[var(--dls-text-secondary)]">
        <textarea
          ref={input}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Message ${props.name}`}
          aria-label={`Message ${props.name}`}
          className="max-h-[200px] min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-[1.5] text-[var(--dls-text-primary)] outline-none placeholder:text-[var(--dls-text-secondary)]"
        />
        <button
          type="button"
          onClick={showStop ? props.onStop : sendNow}
          disabled={showStop ? props.stopping : !canSend}
          aria-label={showStop ? "Stop" : "Send"}
          aria-keyshortcuts={showStop ? "Escape" : "Enter"}
          className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--dls-accent)] text-white transition-opacity duration-150 hover:bg-[var(--dls-accent-hover)] disabled:opacity-35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dls-accent)]"
        >
          {showStop ? <Square size={12} strokeWidth={2} fill="currentColor" aria-hidden /> : <ArrowUp size={16} strokeWidth={2} aria-hidden />}
        </button>
      </div>
    </div>
  );
}
