"use client";

import { ArrowLeft, ChevronDown, ChevronRight, Clock3, Lock, Play, Settings2, ShieldCheck, Square, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { peopleLabel } from "../../(den)/dashboard/_components/access-summary";
import { ConnectorLogo } from "../../(den)/dashboard/_components/item-logo";
import { AppButton, AppSwitch, CardRow, CardShell, Composer, SystemLine, UserBubble } from "./app-parts";
import {
  type Access,
  type Agent,
  type AgentColor,
  type AgentNote,
  type AgentRun,
  type AgentSession,
  type AskItem,
  type RunAsk,
  type RunStep,
  AGENT_COLORS,
  ASK_EXPIRES_MS,
  ROLE_LABEL,
  agentThread,
  canChange,
  connectorById,
  firstNameOf,
  isMine,
  isShared,
  keptNotes,
  lowerFirst,
  nextRunText,
  overBudget,
  personName,
  planLine,
  roleOf,
  routineWhen,
  sharedPeople,
  toolLabel,
  usedByLine,
} from "./model";
// ---------------------------------------------------------------------------
// One agent, one conversation. Every routine reports back here, background work
// shows inline while it runs, and each run is a thread you can reply in.
// ---------------------------------------------------------------------------

export function colorOf(color: AgentColor): string {
  return AGENT_COLORS.find((entry) => entry.id === color)?.fill ?? "#60646c";
}

export function AgentAvatar({ agent, size = 20 }: { agent: Pick<Agent, "name" | "color">; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: colorOf(agent.color), fontSize: Math.round(size * 0.45) }}
      aria-hidden
    >
      {agent.name.trim().charAt(0).toUpperCase() || "A"}
    </span>
  );
}

function clockAt(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// What it is doing right now, in a few words.
export function sessionStateLabel(session: AgentSession, access: Access): string {
  if (session.state === "needs_you") return "Waiting for you";
  if (session.state === "waiting") return `Waiting for one of its ${access.atOnce} at once to finish`;
  const step = session.run.steps[Math.min(session.shown, session.run.steps.length - 1)];
  return step && session.shown < session.run.steps.length ? step.doing ?? step.label : "Writing it up";
}

// ---------------------------------------------------------------------------
// Header: the agent's name opens its details beside the conversation.
// ---------------------------------------------------------------------------

export function ConversationHeader({ agent, access, panelOpen, sub, onPanel, onShare }: {
  agent: Agent;
  access: Access;
  panelOpen: boolean;
  sub?: string;
  onPanel: () => void;
  onShare: () => void;
}) {
  const mine = isMine(agent);
  const shared = isShared(agent.share, agent.owner);
  const count = sharedPeople(agent.share, agent.owner).length;
  return (
    <header className="grid h-12 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-[#f3f4f6] px-3">
      <span className="min-w-0 truncate text-[12px] text-[#8b8d98]" data-testid="conversation-sub">{sub}</span>
      <button
        type="button"
        onClick={onPanel}
        aria-pressed={panelOpen}
        aria-label={`${agent.name} details`}
        data-testid="conversation-name"
        className={`flex h-8 min-w-0 max-w-[260px] items-center gap-2 rounded-full pl-1.5 pr-2.5 text-[13px] font-medium text-[#1c2024] transition-colors hover:bg-[#f0f0f3] ${panelOpen ? "bg-[#f0f0f3]" : ""}`}
      >
        <AgentAvatar agent={agent} size={22} />
        <span className="truncate">{agent.name}</span>
        <ChevronDown className="size-3.5 shrink-0 text-[#8b8d98]" aria-hidden />
      </button>
      <span className="flex justify-end">
        {mine && !agent.setup && (access.sharing || shared) ? (
          <AppButton variant="secondary" icon={UserPlus} onClick={onShare} testId="thread-share">
            {shared ? (agent.share.orgWide ? "Shared with everyone" : `Shared with ${count}`) : "Share"}
          </AppButton>
        ) : null}
      </span>
    </header>
  );
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

export type ConversationProps = {
  agent: Agent;
  access: Access;
  sessions: AgentSession[];
  nowMs: number;
  header: ReactNode;
  onSend: (text: string) => void;
  onStop: (sessionId: string) => void;
  onAnswerAsk: (sessionId: string, answer: RunAsk["state"]) => void;
  onAnswerNote: (noteId: string, keep: boolean) => void;
  onForget: (noteId: string) => void;
  onOpenThread: (id: string) => void;
  onTurnOn: () => void;
};

export function AgentConversation({ agent, access, sessions, nowMs, header, onSend, onStop, onAnswerAsk, onAnswerNote, onForget, onOpenThread, onTurnOn }: ConversationProps) {
  const [text, setText] = useState("");
  const mine = isMine(agent);
  const steers = canChange(agent);
  const items = agentThread(agent);
  const asking = sessions.find((session) => session.kind === "ask") ?? null;
  const background = sessions.filter((session) => session.kind !== "ask");
  const offForMe = !mine && !agent.on && agent.routines.length > 0;
  const scroller = useRef<HTMLDivElement>(null);
  const progress = sessions.map((session) => `${session.id}:${session.shown}:${session.state}:${session.heard.length}`).join("|");

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight });
  }, [items.length, progress]);

  const send = (message: string) => {
    const clean = message.trim();
    if (!clean) return;
    setText("");
    onSend(clean);
  };

  const owner = firstNameOf(agent.owner);
  const note = asking
    ? "It reads your message before it goes on."
    : !steers
      ? `Only you see its answers. Only ${owner} and the managers ${owner} picks can change it.`
      : isShared(agent.share, agent.owner)
        ? "Anything you tell it to keep, it checks with you first, because it changes it for everyone."
        : undefined;

  return (
    <>
      {header}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="agent-thread" data-agent={agent.id} data-role={roleOf(agent) ?? "collaborator"}>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-5 py-6">
          <AgentIntro agent={agent} />

          {offForMe ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#e0e1e6] px-4 py-3" data-testid="thread-off">
              <p className="min-w-0 flex-1 text-[14px] leading-5 text-[#60646c]">Its routines are off for you. You can still ask it things here.</p>
              <AppButton variant="secondary" onClick={onTurnOn} testId="thread-turn-on">Run its routines for me</AppButton>
            </div>
          ) : null}

          {items.map((item) => {
            if (item.kind === "run") {
              return <RunMessage key={item.key} agent={agent} run={item.run} replies={agent.replies.filter((reply) => reply.runId === item.run.id).length} onThread={() => onOpenThread(item.run.id)} />;
            }
            if (item.kind === "memory") {
              return <MemoryAnswer key={item.key} agent={agent} onForget={onForget} />;
            }
            return <NoteExchange key={item.key} agent={agent} note={item.note} onAnswer={(keep) => onAnswerNote(item.note.id, keep)} />;
          })}

          {background.map((session) => (
            session.state === "needs_you" && session.ask ? (
              <AskCard key={session.id} agent={agent} session={session} nowMs={nowMs} onAnswer={(answer) => onAnswerAsk(session.id, answer)} />
            ) : (
              <SessionLine key={session.id} agent={agent} session={session} access={access} onOpen={() => onOpenThread(session.id)} onStop={() => onStop(session.id)} />
            )
          ))}

          {asking ? (
            <div className="flex flex-col gap-3" data-testid="conversation-asking">
              {asking.asked ? <UserBubble>{asking.asked}</UserBubble> : null}
              {asking.state === "needs_you" && asking.ask ? (
                <AskCard agent={agent} session={asking} nowMs={nowMs} onAnswer={(answer) => onAnswerAsk(asking.id, answer)} />
              ) : (
                <WorkingLine agent={agent} label={sessionStateLabel(asking, access)} />
              )}
              {asking.heard.map((heard) => (
                <div key={heard} className="flex flex-col items-end gap-1">
                  <UserBubble>{heard}</UserBubble>
                  <span className="pr-2 text-[12px] text-[#8b8d98]">Read before it goes on</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mx-auto w-full max-w-[720px]">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => send(text)}
            placeholder={`Message ${agent.name}`}
            working={asking !== null}
            onStop={asking ? () => onStop(asking.id) : undefined}
            note={note}
          />
        </div>
      </div>
    </>
  );
}

// What the agent says, in its own voice: its face, then plain text.
export function AgentSays({ agent, children, testId }: { agent: Agent; children: ReactNode; testId?: string }) {
  return (
    <div className="flex gap-2.5" data-testid={testId}>
      <span className="pt-0.5"><AgentAvatar agent={agent} size={20} /></span>
      <div className="min-w-0 flex-1 text-[14px] leading-6 text-[#1c2024]">{children}</div>
    </div>
  );
}

// How the conversation opens. An agent made by telling it its job keeps that exchange at the top.
// Any other agent says what it is for in one line.
function AgentIntro({ agent }: { agent: Agent }) {
  const mine = isMine(agent);
  const first = agent.routines[0];
  if (agent.said.length > 0 && mine) {
    return (
      <div className="flex flex-col gap-5" data-testid="thread-intro">
        <UserBubble>{agent.said}</UserBubble>
        {first ? <AgentSays agent={agent}>{planLine(agent, first.schedule)}</AgentSays> : null}
        {first ? <SystemLine icon={Clock3} testId="thread-created">{`Created routine · ${first.name}`}</SystemLine> : null}
        <AgentSays agent={agent} testId="thread-started">You're set. The first check is running now. I'll ask before I change anything in your apps.</AgentSays>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1.5 pb-2 pt-4 text-center" data-testid="thread-intro">
      <AgentAvatar agent={agent} size={40} />
      <p className="pt-1 text-[14px] font-medium leading-5 text-[#1c2024]">{agent.name}</p>
      <p className="max-w-[520px] whitespace-pre-line text-[13px] leading-5 text-[#60646c]" data-testid="thread-instructions">{agent.instructions || "Tell it what to do."}</p>
      {mine ? null : (
        <p className="text-[12px] leading-4 text-[#8b8d98]" data-testid="thread-terms">{`From ${firstNameOf(agent.owner)}. This conversation is yours alone, and it uses your own accounts.`}</p>
      )}
    </div>
  );
}

export function WorkingLine({ agent, label }: { agent: Agent; label: string }) {
  return (
    <p className="flex items-center gap-2.5 text-[14px] leading-5 text-[#8b8d98]" role="status" data-testid="working-line">
      <span className="animate-pulse motion-reduce:animate-none"><AgentAvatar agent={agent} size={20} /></span>
      {label}
    </p>
  );
}

function StepLogo({ connector }: { connector: RunStep["connector"] | AskItem["connector"] }) {
  if (connector === "openwork") {
    return (
      <span className="grid size-6 shrink-0 place-items-center rounded-md border border-gray-200 bg-white">
        <img src="/openwork-mark.svg" alt="" className="size-3.5" />
      </span>
    );
  }
  if (connector === "workbot") return <ConnectorLogo name="Slack" url="https://slack.com" size="xs" />;
  const entry = connectorById(connector);
  return <ConnectorLogo name={entry.name} url={entry.url} size="xs" />;
}

export function RunSteps({ steps }: { steps: RunStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" data-testid="run-steps">
      {steps.map((step) => (
        <li key={step.key} className="flex items-center gap-2.5 text-[13px] leading-5 text-[#60646c]" data-blocked={step.blocked ? "true" : "false"}>
          <span className="grid size-6 shrink-0 place-items-center"><StepLogo connector={step.connector} /></span>
          <span className="min-w-0 flex-1">{step.label}</span>
          {step.blocked ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-[12px] text-[#8b8d98]">
              <Lock className="size-3" aria-hidden />
              {step.blocked === "Not allowed" ? "Not allowed" : `${toolLabel(step.tool)}: ${step.blocked.toLowerCase()}`}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// What it asked to do, and how that ended, as one small line.
function askEnding(agent: Agent, wanted: RunAsk): string {
  const one = wanted.items.length === 1 ? wanted.items[0] : undefined;
  const what = one ? lowerFirst(one.action) : `do those ${wanted.items.length} things`;
  if (wanted.state === "expired") return `Nobody answered in 30 minutes, so ${agent.name} didn't ${what}`;
  if (wanted.state === "denied") return `You said no, so ${agent.name} didn't ${what}`;
  return `${agent.name} can ${what} ${wanted.state === "always" ? "from now on" : "this time"}`;
}

// One result in the conversation: a sentence or two. The steps behind it stay folded until asked for.
export function RunMessage({ agent, run, replies, onThread, inThread = false }: {
  agent: Agent;
  run: AgentRun;
  replies: number;
  onThread: (() => void) | null;
  inThread?: boolean;
}) {
  const [open, setOpen] = useState(inThread);
  const source = run.asked ? null : run.routine ?? "Run now";
  const tone = run.outcome === "failed" || run.outcome === "over_budget" ? "text-[#9a4a00]" : run.outcome === "quiet" ? "text-[#60646c]" : "text-[#1c2024]";
  const count = run.steps.length;
  return (
    <div className="flex flex-col gap-3" data-testid="thread-run" data-outcome={run.outcome} data-asked={run.asked ? "true" : "false"} data-routine={run.routine ?? ""}>
      {run.asked && !inThread ? <UserBubble>{run.asked}</UserBubble> : null}
      {run.heard && !inThread ? <UserBubble>{run.heard}</UserBubble> : null}
      {run.wanted ? <SystemLine icon={ShieldCheck} testId="thread-run-ask">{askEnding(agent, run.wanted)}</SystemLine> : null}
      <div className="flex gap-2.5">
        <span className="pt-0.5"><AgentAvatar agent={agent} size={20} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className={`text-[14px] leading-6 ${tone}`} data-testid="thread-run-summary">{run.summary}</p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] leading-5 text-[#8b8d98]">
            <span data-testid="thread-run-routine">{source ? `${source} · ${run.when}` : run.when}</span>
            {count > 0 && !inThread ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => setOpen((current) => !current)}
                  aria-expanded={open}
                  data-testid="run-steps-toggle"
                  className="inline-flex items-center gap-0.5 rounded transition-colors hover:text-[#1c2024]"
                >
                  {`${count} ${count === 1 ? "step" : "steps"}`}
                  <ChevronRight className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden />
                </button>
              </>
            ) : null}
            {onThread ? (
              <>
                <span aria-hidden>·</span>
                <button type="button" onClick={onThread} data-testid="thread-reply" className="rounded transition-colors hover:text-[#1c2024]">
                  {replies > 0 ? `${replies} ${replies === 1 ? "reply" : "replies"}` : "Reply"}
                </button>
              </>
            ) : null}
          </p>
          {open ? <div className="pt-1"><RunSteps steps={run.steps} /></div> : null}
        </div>
      </div>
    </div>
  );
}

// Work going on in the background, as one quiet line until it reports back.
function SessionLine({ agent, session, access, onOpen, onStop }: { agent: Agent; session: AgentSession; access: Access; onOpen: () => void; onStop: () => void }) {
  return (
    <div className="flex items-center gap-2.5" data-testid="session-line" data-state={session.state}>
      <span className={session.state === "working" ? "animate-pulse motion-reduce:animate-none" : "opacity-50"}><AgentAvatar agent={agent} size={20} /></span>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left text-[14px] leading-5 text-[#8b8d98] transition-colors hover:text-[#60646c]" role="status">
        {sessionStateLabel(session, access)}
      </button>
      <button type="button" onClick={onStop} data-testid="session-stop" className="shrink-0 rounded px-1 text-[12px] font-medium text-[#8b8d98] transition-colors hover:text-[#1c2024]">
        {session.state === "waiting" ? "Cancel" : "Stop"}
      </button>
    </div>
  );
}

// The first time it wants to change something, it stops and asks, in the chat. Reading never asks.
// Asked from the background, the question expires after 30 minutes and nothing is changed.
export function AskCard({ agent, session, nowMs, onAnswer }: {
  agent: Agent;
  session: AgentSession;
  nowMs: number;
  onAnswer: (answer: RunAsk["state"]) => void;
}) {
  const ask = session.ask;
  if (!ask) return null;
  const left = Math.max(0, Math.ceil((ask.raisedMs + ASK_EXPIRES_MS - nowMs) / 60000));
  const one = ask.items.length === 1 ? ask.items[0] : undefined;
  return (
    <div className="flex flex-col gap-1.5 pl-[30px]">
      <section className="flex w-full max-w-[560px] flex-col gap-3 rounded-2xl border border-[#e0e1e6] bg-[#fcfcfd] p-4" data-testid="ask-card" data-state="ask" data-tools={ask.items.map((item) => item.tool).join(",")}>
        <h3 className="text-[14px] font-medium leading-5 text-[#1c2024]">{one ? `Let ${agent.name} ${lowerFirst(one.action)}?` : `Let ${agent.name} do this?`}</h3>
        {one ? null : (
          <ul className="flex flex-col gap-1">
            {ask.items.map((item) => (
              <li key={`${item.connector}-${item.tool}`} className="flex items-center gap-2.5 text-[14px] leading-5 text-[#1c2024]" data-testid="ask-item">
                <span className="grid size-6 shrink-0 place-items-center"><StepLogo connector={item.connector} /></span>
                {item.action}
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] leading-4 text-[#8b8d98]">It uses your own accounts. You can change this any time in its settings.</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <AppButton variant="quiet" onClick={() => onAnswer("denied")} testId="ask-deny">Deny</AppButton>
          <AppButton variant="secondary" onClick={() => onAnswer("always")} testId="ask-always">Always allow</AppButton>
          <AppButton onClick={() => onAnswer("allowed")} testId="ask-allow-once">Allow once</AppButton>
        </div>
      </section>
      {/* Only once it has waited a while: someone answering at once doesn't need to hear about the deadline. */}
      {ask.background && left <= 28 ? (
        <p className="max-w-[560px] px-1 text-[12px] leading-4 text-[#8b8d98]" data-testid="ask-expiry">
          {`If you don't answer by ${clockAt(ask.raisedMs + ASK_EXPIRES_MS)}, it skips this and changes nothing.`}
        </p>
      ) : null}
    </div>
  );
}

// "What do you remember?" is answered in the conversation. There is no memory screen.
function MemoryAnswer({ agent, onForget }: { agent: Agent; onForget: (noteId: string) => void }) {
  const kept = keptNotes(agent);
  const steers = canChange(agent);
  const shared = isShared(agent.share, agent.owner);
  return (
    <div className="flex flex-col gap-3" data-testid="memory-answer">
      <UserBubble>What do you remember?</UserBubble>
      <div className="flex gap-2.5">
        <span className="pt-0.5"><AgentAvatar agent={agent} size={20} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="text-[14px] leading-6 text-[#1c2024]">
            {kept.length === 0
              ? "Nothing beyond my job yet. Tell me something here and I'll keep it in mind every time."
              : `Besides my job, I keep ${kept.length === 1 ? "this" : `these ${kept.length} things`} in mind every time${shared ? ", for everyone who uses me" : ""}:`}
          </p>
          {kept.length > 0 ? (
            <ul className="flex flex-col divide-y divide-[#f3f4f6] rounded-xl border border-[#e0e1e6]">
              {kept.map((note) => (
                <li key={note.id} className="flex min-h-10 items-center gap-3 px-3 py-1.5" data-testid="memory-item">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[13px] leading-5 text-[#1c2024]">{note.text}</span>
                    {shared ? <span className="text-[12px] leading-4 text-[#8b8d98]">{note.by === agent.owner && isMine(agent) ? "You told me" : `${personName(note.by)} told me`}</span> : null}
                  </span>
                  {steers ? <AppButton variant="quiet" onClick={() => onForget(note.id)} testId="memory-forget">Forget</AppButton> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Something you told it to keep. A shared agent asks first, on the same card.
function NoteExchange({ agent, note, onAnswer }: { agent: Agent; note: AgentNote; onAnswer: (keep: boolean) => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="thread-note" data-state={note.state}>
      <UserBubble>{note.text}</UserBubble>
      <div className="flex gap-2.5">
        <span className="pt-0.5"><AgentAvatar agent={agent} size={20} /></span>
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {note.forEveryone ? (
            <NoteCard agent={agent} note={note} onAnswer={onAnswer} />
          ) : (
            <p className="text-[14px] leading-6 text-[#1c2024]">Got it. I'll keep that in mind every time.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function NoteCard({ agent, note, onAnswer }: { agent: Agent; note: AgentNote; onAnswer: (keep: boolean) => void }) {
  const owner = firstNameOf(agent.owner);
  const others = !isMine(agent)
    ? `${owner} and the other managers see that you added it, and can ask me to forget it.`
    : agent.managers.length > 0 ? "Your managers see that you added it, and can ask me to forget it." : "Ask me to forget it any time.";
  return (
    <CardShell
      icon={ShieldCheck}
      title={note.state === "ask" ? "Keep this for everyone?" : note.state === "kept" ? "Kept for everyone" : "Not kept"}
      testId="thread-note-card"
      dataState={note.state}
      state={note.state === "ask" ? "Needs your OK" : note.state === "kept" ? "Remembered" : "Nothing changed"}
      footer={note.state === "ask" ? (
        <>
          <AppButton onClick={() => onAnswer(true)} testId="thread-note-accept">Keep for everyone</AppButton>
          <AppButton variant="quiet" onClick={() => onAnswer(false)} testId="thread-note-decline">Not now</AppButton>
        </>
      ) : undefined}
    >
      <div className="flex flex-col gap-2">
        <CardRow label="Keep">{`“${note.text}”`}</CardRow>
        {note.state === "dropped" ? null : <CardRow label="Changes it for">{usedByLine(agent)}</CardRow>}
        {note.state === "ask" ? <CardRow label="Who sees it">{others}</CardRow> : null}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Beside the conversation: a thread about one run, or the agent's details.
// ---------------------------------------------------------------------------

export function SidePanel({ label, title, onClose, children, footer, testId, wide = false }: {
  label: string;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId: string;
  wide?: boolean;
}) {
  return (
    <aside
      className={`flex min-h-0 w-full min-w-0 flex-col lg:shrink-0 lg:border-l lg:border-[#e0e1e6] ${wide ? "lg:w-[440px]" : "lg:w-[380px]"}`}
      aria-label={label}
      data-testid={testId}
    >
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-[#f3f4f6] pl-4 pr-2">
        <div className="flex min-w-0 items-center gap-2">{title}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${label.toLowerCase()}`}
          data-testid="panel-close"
          className="grid size-8 shrink-0 place-items-center rounded-lg text-[#60646c] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c2024]"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid={`${testId}-scroll`}>{children}</div>
      {footer ? <div className="shrink-0 px-4 pb-4 pt-2">{footer}</div> : null}
    </aside>
  );
}

// A thread keeps the follow-up about one run. It can't change the agent: that happens in the conversation.
export function ThreadPanel({ agent, access, run, session, nowMs, onReply, onMove, onStop, onAnswerAsk, onClose }: {
  agent: Agent;
  access: Access;
  run: AgentRun | null;
  session: AgentSession | null;
  nowMs: number;
  onReply: (text: string) => void;
  onMove: (replyId: string) => void;
  onStop: () => void;
  onAnswerAsk: (answer: RunAsk["state"]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const runId = run?.id ?? session?.id ?? "";
  const replies = agent.replies.filter((reply) => reply.runId === runId);
  const label = run ? (run.routine ?? (run.asked ? "Your question" : "Run now")) : session?.label ?? "";
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scroller.current?.parentElement;
    if (node) node.scrollTo({ top: node.scrollHeight });
  }, [replies.length, session?.shown]);
  return (
    <SidePanel
      label="Thread"
      testId="thread-panel"
      title={(
        <>
          <span className="text-[13px] font-medium text-[#1c2024]">Thread</span>
          <span className="truncate text-[12px] text-[#8b8d98]">{`${label}${run ? ` · ${run.when}` : ""}`}</span>
        </>
      )}
      onClose={onClose}
      footer={run ? (
        <Composer
          value={text}
          onChange={setText}
          onSubmit={() => { onReply(text.trim()); setText(""); }}
          placeholder="Reply about this result"
          note="A reply here is about this result only."
        />
      ) : undefined}
    >
      <div ref={scroller} className="flex flex-col gap-5 px-4 py-4">
        {run ? <RunMessage agent={agent} run={run} replies={0} onThread={null} inThread /> : null}
        {session ? (
          <div className="flex flex-col gap-3" data-testid="thread-live" data-state={session.state}>
            <p className="text-[12px] leading-4 text-[#8b8d98]">{`Started ${session.run.when}`}</p>
            <RunSteps steps={session.run.steps.slice(0, session.shown)} />
            {session.state === "needs_you" && session.ask ? (
              <AskCard agent={agent} session={session} nowMs={nowMs} onAnswer={onAnswerAsk} />
            ) : (
              <WorkingLine agent={agent} label={sessionStateLabel(session, access)} />
            )}
            {session.state !== "needs_you" ? <AppButton variant="secondary" icon={Square} onClick={onStop} testId="thread-stop">{session.state === "waiting" ? "Cancel" : "Stop now"}</AppButton> : null}
          </div>
        ) : null}
        {replies.map((reply) => reply.from === "agent" ? (
          <div key={reply.id} className="flex gap-2.5" data-testid="thread-reply-agent">
            <span className="pt-0.5"><AgentAvatar agent={agent} size={20} /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <p className="text-[14px] leading-6 text-[#1c2024]">{reply.text}</p>
              {reply.move ? (
                reply.move.done ? (
                  <span className="text-[12px] text-[#8b8d98]" data-testid="thread-moved">Said in the conversation.</span>
                ) : (
                  <span><AppButton variant="secondary" onClick={() => onMove(reply.id)} testId="thread-move">Say it in the conversation</AppButton></span>
                )
              ) : null}
            </div>
          </div>
        ) : (
          <UserBubble key={reply.id}>{reply.text}</UserBubble>
        ))}
      </div>
    </SidePanel>
  );
}

// ---------------------------------------------------------------------------
// Details: a glance. Is it on, when does it work next, what is it doing now.
// Everything else (tools, budget, where it works, sharing, its file) is in Settings.
// ---------------------------------------------------------------------------

export type DetailsTab = "activity" | "settings";

export function DetailsPanel({ agent, access, sessions, tab, onTab, onClose, onToggle, onRename, onRun, onOpenThread, settings }: {
  agent: Agent;
  access: Access;
  sessions: AgentSession[];
  tab: DetailsTab;
  onTab: (tab: DetailsTab) => void;
  onClose: () => void;
  onToggle: (on: boolean) => void;
  onRename: (name: string) => void;
  onRun: () => void;
  onOpenThread: (id: string) => void;
  settings: ReactNode;
}) {
  return (
    <SidePanel
      label="Details"
      testId="settings-panel"
      wide={tab === "settings"}
      onClose={onClose}
      title={tab === "settings" ? (
        <button
          type="button"
          onClick={() => onTab("activity")}
          data-testid="details-back"
          className="-ml-2 flex h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-[#1c2024] transition-colors hover:bg-[#f0f0f3]"
        >
          <ArrowLeft className="size-4 text-[#60646c]" aria-hidden />
          Settings
        </button>
      ) : undefined}
    >
      {tab === "activity" ? (
        <Glance agent={agent} access={access} sessions={sessions} onToggle={onToggle} onRename={onRename} onRun={onRun} onOpenThread={onOpenThread} onSettings={() => onTab("settings")} />
      ) : (
        <div className="px-4 py-4" data-testid="settings-scroll">{settings}</div>
      )}
    </SidePanel>
  );
}

// The name is a text box in place: click it, type, done. Nobody has to name an agent before it exists.
function NameField({ agent, onRename }: { agent: Agent; onRename: (name: string) => void }) {
  const [name, setName] = useState(agent.name);
  useEffect(() => setName(agent.name), [agent.name]);
  const save = () => {
    const next = name.trim();
    if (next.length === 0) setName(agent.name);
    else if (next !== agent.name) onRename(next);
  };
  return (
    <input
      value={name}
      maxLength={40}
      aria-label="Name"
      onChange={(event) => setName(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      data-testid="details-name"
      className="h-8 w-full max-w-[260px] rounded-lg bg-transparent px-2 text-center text-[15px] font-medium text-[#1c2024] outline-none transition-colors hover:bg-[#f0f0f3] focus:bg-[#f0f0f3]"
    />
  );
}

function GlanceLabel({ children }: { children: string }) {
  return <h3 className="px-1 pb-1.5 pt-4 text-[12px] font-medium text-[#8b8d98]">{children}</h3>;
}

function Glance({ agent, access, sessions, onToggle, onRename, onRun, onOpenThread, onSettings }: {
  agent: Agent;
  access: Access;
  sessions: AgentSession[];
  onToggle: (on: boolean) => void;
  onRename: (name: string) => void;
  onRun: () => void;
  onOpenThread: (id: string) => void;
  onSettings: () => void;
}) {
  const mine = isMine(agent);
  const role = roleOf(agent) ?? "collaborator";
  const over = overBudget(agent, access);
  const fresh = agent.setup !== null;
  const status = fresh ? "Not started yet" : !agent.on ? (mine ? "Paused" : "Off for you") : over ? "Over budget" : "On";
  const line = fresh
    ? "Tell it what to do in the chat."
    : !agent.on
      ? mine ? "It does nothing until you turn it on." : "You can still ask it things."
      : over ? "It works again next month, or when its budget is raised in Settings." : `${nextRunText(agent)}.`;
  return (
    <div className="flex flex-col px-4 pb-4" data-testid="details-activity">
      <div className="flex flex-col items-center gap-1 pb-2 pt-6">
        <AgentAvatar agent={agent} size={56} />
        <div className="flex w-full justify-center pt-2">
          {mine ? <NameField agent={agent} onRename={onRename} /> : <p className="flex h-8 items-center text-[15px] font-medium text-[#1c2024]" data-testid="details-name">{agent.name}</p>}
        </div>
        {mine ? null : <p className="text-[12px] leading-4 text-[#8b8d98]">{`From ${personName(agent.owner)} · ${ROLE_LABEL[role]}`}</p>}
      </div>

      <div className="mt-3 flex min-h-14 items-center justify-between gap-3 rounded-2xl border border-[#e0e1e6] px-3.5 py-2.5" data-testid="details-status">
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-medium leading-5 text-[#1c2024]" data-testid="details-status-title">{status}</span>
          <span className="text-[12px] leading-4 text-[#8b8d98]">{line}</span>
        </span>
        <AppSwitch checked={agent.on} onChange={onToggle} label={mine ? agent.name : `Run ${agent.name}'s routines for me`} testId="agent-on" />
      </div>

      <GlanceLabel>Routines</GlanceLabel>
      <div className="flex flex-col divide-y divide-[#f3f4f6] rounded-2xl border border-[#e0e1e6]" data-testid="details-routines">
        {agent.routines.length === 0 ? <p className="px-3.5 py-3 text-[13px] leading-5 text-[#60646c]">None yet. Tell it when to work, in the chat.</p> : null}
        {agent.routines.map((routine) => (
          <div key={routine.id} className="flex min-h-12 items-center gap-3 px-3.5 py-2" data-testid={`details-routine-${routine.id}`} data-on={routine.on ? "true" : "false"}>
            <Clock3 className="size-4 shrink-0 text-[#8b8d98]" aria-hidden />
            <span className="flex min-w-0 flex-col">
              <span className={`truncate text-[13px] leading-5 ${routine.on ? "text-[#1c2024]" : "text-[#8b8d98]"}`}>{routine.name}</span>
              <span className="truncate text-[12px] leading-4 text-[#8b8d98]">{routineWhen(routine)}</span>
            </span>
          </div>
        ))}
      </div>

      {sessions.length > 0 ? (
        <>
          <GlanceLabel>Working now</GlanceLabel>
          <div className="flex flex-col divide-y divide-[#f3f4f6] rounded-2xl border border-[#e0e1e6]" data-testid="details-sessions">
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                onClick={() => onOpenThread(session.id)}
                className="flex min-h-12 items-center gap-3 px-3.5 py-2 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-[#f9f9fb]"
                data-testid="details-session"
                data-state={session.state}
              >
                <span className={`size-2 shrink-0 rounded-full ${session.state === "needs_you" ? "bg-[#E8933A]" : session.state === "working" ? "animate-pulse bg-[#0090ff] motion-reduce:animate-none" : "bg-[#d9d9e0]"}`} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] leading-5 text-[#1c2024]">{session.label}</span>
                  <span className="truncate text-[12px] leading-4 text-[#8b8d98]">{sessionStateLabel(session, access)}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="flex items-center gap-2 pt-4">
        {fresh ? null : <AppButton variant="secondary" icon={Play} onClick={onRun} testId="thread-run-now">Run now</AppButton>}
        <AppButton variant="quiet" icon={Settings2} onClick={onSettings} testId="details-settings">Settings</AppButton>
      </div>

      {!mine ? (
        <p className="px-1 pt-4 text-[12px] leading-4 text-[#8b8d98]">{`Used by ${peopleLabel(sharedPeople(agent.share, agent.owner).length + 1)}. Each person has their own conversation.`}</p>
      ) : null}
    </div>
  );
}
