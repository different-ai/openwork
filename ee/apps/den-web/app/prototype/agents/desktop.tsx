"use client";

import { Menu } from "@base-ui/react/menu";
import {
  BarChart3,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  LayoutGrid,
  Play,
  Plug,
  Plus,
  Repeat,
  Settings2,
  ShieldCheck,
  SquarePen,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { type AccessDraft, peopleLabel } from "../../(den)/dashboard/_components/access-summary";
import { ConnectorLogo } from "../../(den)/dashboard/_components/item-logo";
import { formatWorkbotCost } from "../../(den)/dashboard/_features/workbot-usage/workbot-usage-data";
import { AppButton, CardDetails, CardRow, CardShell, Composer, PaneHeader, ToolList, UserBubble, Working, accessWord } from "./app-parts";
import {
  AgentAvatar,
  AgentConversation,
  ConversationHeader,
  DetailsPanel,
  type DetailsTab,
  RunSteps,
  ThreadPanel,
} from "./conversation";
import {
  type Access,
  type Agent,
  type AgentRun,
  type AgentSession,
  type ChatCard,
  type ChatStep,
  type ChatTurn,
  type ConnectorId,
  type RunAsk,
  type Schedule,
  CHAT_EXTRAS,
  MEMBER,
  NOT_SHARED,
  PEOPLE,
  ROLE_LABEL,
  STORY,
  TEAMS,
  agentSlug,
  canChange,
  canSee,
  connectorById,
  draftUses,
  firstNameOf,
  inMyList,
  isMine,
  isWriteTool,
  listWords,
  nextRunLine,
  personName,
  presetOf,
  roleOf,
  sampleAgents,
  scheduleLine,
  shareTargets,
  sharedPeople,
  toolLabel,
  toolsLine,
  usedByMe,
} from "./model";
import { Dialog } from "./parts";
import { AgentSettings, MonthSpend, SharedAgentSettings } from "./settings";
import { NewAgentChat } from "./setup";
import { BrowseDialog, ShareDialog } from "./share";

// ---------------------------------------------------------------------------
// The OpenWork desktop app, built on one idea from Grok Bot: each agent is a
// named character with one job and one conversation. A new agent starts as a
// chat: say its job and it is working. It asks for a tool the first time it
// needs it. Its details are a glance beside the chat; settings are one step in.
// ---------------------------------------------------------------------------

export type DesktopView =
  | { kind: "chat" }
  | { kind: "agent"; agentId: string; panel: DetailsTab | null; thread: string | null; share?: boolean };

export type DesktopAppProps = {
  view: DesktopView;
  onView: (view: DesktopView) => void;
  agents: Agent[];
  access: Access;
  connected: Record<ConnectorId, boolean>;
  turns: ChatTurn[];
  unreadIds: string[];
  sessions: AgentSession[];
  nowMs: number;
  onAsk: (prompt: string) => void;
  onCard: (turnId: string, accept: boolean) => void;
  // A message in an agent's conversation: a question, something to keep, or "run it".
  onSend: (agentId: string, text: string) => void;
  // Without a routine it runs the agent once, on its instructions alone.
  onRun: (agentId: string, routineId?: string) => void;
  onStop: (sessionId: string) => void;
  onAnswerAsk: (sessionId: string, answer: RunAsk["state"]) => void;
  // A note on a shared agent waits for this: keep it for everyone, or not.
  onAnswerNote: (agentId: string, noteId: string, keep: boolean) => void;
  onRemoveNote: (agentId: string, noteId: string) => void;
  onReply: (agentId: string, runId: string, text: string) => void;
  onMoveReply: (agentId: string, replyId: string) => void;
  onPatch: (agentId: string, patch: Partial<Agent>) => void;
  removed: Agent | null;
  onRemove: (agent: Agent) => void;
  onUndoRemove: () => void;
  onCopy: (agent: Agent) => void;
  onShare: (agentId: string, share: AccessDraft, managers: string[]) => void;
  onConnect: (id: ConnectorId) => void;
  // A new agent starts as an empty chat. Its first message is its job; one answer starts it.
  onCreate: () => void;
  onJob: (agentId: string, text: string) => void;
  onAskOften: (agentId: string, asking: "start" | "often") => void;
  onStart: (agentId: string, schedule?: Schedule) => void;
};

const APP_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const SAMPLE_NAMES = sampleAgents().map((agent) => agent.name);

type Mark = "needs_you" | "working" | "unread" | null;

export function DesktopApp(props: DesktopAppProps) {
  const {
    view, onView, agents, access, connected, turns, unreadIds, sessions, nowMs, onAsk, onCard, onSend, onRun, onStop, onAnswerAsk, onAnswerNote,
    onRemoveNote, onReply, onMoveReply, onPatch, removed, onRemove, onUndoRemove, onCopy, onShare, onConnect, onCreate, onJob, onAskOften, onStart,
  } = props;
  const [dialog, setDialog] = useState<"browse" | "usage" | null>(null);
  const found = view.kind === "agent" ? agents.find((agent) => agent.id === view.agentId) ?? null : null;
  const agent = found && canSee(found, access) ? found : null;
  const listed = agents.filter((entry) => inMyList(entry, access));
  const atAgentLimit = agents.filter(isMine).length >= access.maxAgents;
  const panel = view.kind === "agent" ? view.panel : null;
  const threadId = view.kind === "agent" ? view.thread : null;
  const shareAgent = view.kind === "agent" && view.share === true && agent && isMine(agent) ? agent : null;
  const agentSessions = agent ? sessions.filter((session) => session.agentId === agent.id) : [];

  const markOf = (entry: Agent): Mark => {
    const mine = sessions.filter((session) => session.agentId === entry.id);
    if (mine.some((session) => session.state === "needs_you")) return "needs_you";
    if (mine.some((session) => session.state === "working")) return "working";
    return unreadIds.includes(entry.id) ? "unread" : null;
  };

  const openAgent = (agentId: string) => onView({ kind: "agent", agentId, panel: null, thread: null });
  const go = (patch: Partial<{ panel: DetailsTab | null; thread: string | null; share: boolean }>) => {
    if (view.kind !== "agent") return;
    onView({ ...view, share: false, ...patch });
  };
  const leave = (agentId: string) => {
    onPatch(agentId, { added: false, on: false });
    onView({ kind: "chat" });
  };

  const threadRun = agent && threadId ? agent.runs.find((run) => run.id === threadId) ?? null : null;
  const threadSession = agent && threadId ? agentSessions.find((session) => session.id === threadId) ?? null : null;
  const side = threadRun || threadSession ? "thread" : panel ? "details" : null;

  const settings = agent ? (
    canChange(agent) ? (
      <AgentSettings
        agent={agent}
        access={access}
        connected={connected}
        running={agentSessions.some((session) => session.state === "working")}
        onPatch={(patch) => onPatch(agent.id, patch)}
        onRemove={() => onRemove(agent)}
        onLeave={() => leave(agent.id)}
        onConnect={onConnect}
        onOpenShare={() => go({ share: true })}
        onStopSharing={() => onShare(agent.id, NOT_SHARED, [])}
        onRun={(routineId) => onRun(agent.id, routineId)}
      />
    ) : (
      <SharedAgentSettings
        agent={agent}
        access={access}
        connected={connected}
        atAgentLimit={atAgentLimit}
        onPatch={(patch) => onPatch(agent.id, patch)}
        onCopy={() => onCopy(agent)}
        onLeave={() => leave(agent.id)}
        onConnect={onConnect}
      />
    )
  ) : null;

  const sub = agent && !isMine(agent) ? `From ${firstNameOf(agent.owner)} · ${ROLE_LABEL[roleOf(agent) ?? "collaborator"]}` : undefined;
  const sharedToAdd = agents.filter((entry) => !isMine(entry) && canSee(entry, access) && !entry.added).length;

  const header = agent ? (
    <ConversationHeader
      agent={agent}
      access={access}
      panelOpen={side === "details"}
      sub={sub}
      onPanel={() => go({ panel: side === "details" ? null : panel ?? "activity", thread: null })}
      onShare={() => go({ share: true })}
    />
  ) : null;

  return (
    <div className="flex min-h-0 flex-1 bg-[#f9f9fb] text-[13px] text-[#1c2024]" style={{ fontFamily: APP_FONT }} data-testid="desktop-app">
      <Sidebar
        view={view}
        listed={listed}
        markOf={markOf}
        onChat={() => onView({ kind: "chat" })}
        onAgent={openAgent}
        onNew={onCreate}
        canAdd={!atAgentLimit}
        maxAgents={access.maxAgents}
        sharedToAdd={sharedToAdd}
        onBrowse={() => setDialog("browse")}
        onUsage={() => setDialog("usage")}
      />

      <main className="flex min-w-0 flex-1 p-2 pl-0">
        <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden rounded-[14px] border border-[#e0e1e6] bg-[#fcfcfd] shadow-[0_8px_24px_rgba(15,23,42,0.06)]">
          {view.kind === "chat" || !agent ? (
            <SetupChat
              turns={turns}
              agents={agents}
              access={access}
              onAsk={onAsk}
              onCard={onCard}
              onOpenThread={openAgent}
              onOpenShare={(agentId) => onView({ kind: "agent", agentId, panel: null, thread: null, share: true })}
              onOpenAgents={() => setDialog("usage")}
            />
          ) : (
            <div className="flex min-h-0 min-w-0 flex-1">
              {/* Wide windows show the conversation and its side panel together. Narrow ones show one at a time. */}
              <div className={`min-w-0 flex-1 flex-col ${side ? "hidden lg:flex" : "flex"}`}>
                {agent.setup ? (
                  <NewAgentChat
                    key={agent.id}
                    agent={agent}
                    setup={agent.setup}
                    header={header}
                    onJob={(text) => onJob(agent.id, text)}
                    onAskOften={(asking) => onAskOften(agent.id, asking)}
                    onStart={(schedule) => onStart(agent.id, schedule)}
                  />
                ) : (
                  <AgentConversation
                    key={agent.id}
                    agent={agent}
                    access={access}
                    sessions={agentSessions}
                    nowMs={nowMs}
                    header={header}
                    onSend={(text) => onSend(agent.id, text)}
                    onStop={onStop}
                    onAnswerAsk={onAnswerAsk}
                    onAnswerNote={(noteId, keep) => onAnswerNote(agent.id, noteId, keep)}
                    onForget={(noteId) => onRemoveNote(agent.id, noteId)}
                    onOpenThread={(id) => go({ thread: id })}
                    onTurnOn={() => onPatch(agent.id, { on: true })}
                  />
                )}
              </div>
              {side === "thread" ? (
                <ThreadPanel
                  key={threadId ?? ""}
                  agent={agent}
                  access={access}
                  run={threadRun}
                  session={threadSession}
                  nowMs={nowMs}
                  onReply={(text) => { if (threadRun) onReply(agent.id, threadRun.id, text); }}
                  onMove={(replyId) => onMoveReply(agent.id, replyId)}
                  onStop={() => { if (threadSession) onStop(threadSession.id); }}
                  onAnswerAsk={(answer) => { if (threadSession) onAnswerAsk(threadSession.id, answer); }}
                  onClose={() => go({ thread: null })}
                />
              ) : side === "details" && panel ? (
                <DetailsPanel
                  key={agent.id}
                  agent={agent}
                  access={access}
                  sessions={agentSessions}
                  tab={panel}
                  onTab={(tab) => go({ panel: tab })}
                  onClose={() => go({ panel: null })}
                  onToggle={(on) => onPatch(agent.id, { on })}
                  onRename={(name) => onPatch(agent.id, { name })}
                  onRun={() => onRun(agent.id)}
                  onOpenThread={(id) => go({ thread: id })}
                  settings={settings}
                />
              ) : null}
            </div>
          )}
          {removed ? (
            <p className="absolute bottom-4 left-4 flex items-center gap-2 rounded-xl border border-[#e0e1e6] bg-white px-3 py-2 text-[13px] leading-5 text-[#60646c] shadow-[0_8px_24px_rgba(15,23,42,0.08)]" role="status" data-testid="agents-removed">
              {`Removed ${removed.name}.`}
              <button type="button" onClick={onUndoRemove} className="rounded font-medium text-[#1c2024] underline-offset-2 hover:underline" data-testid="agents-undo">Undo</button>
            </p>
          ) : null}
        </div>
      </main>

      {dialog === "browse" ? (
        <BrowseDialog
          agents={agents}
          access={access}
          onAdd={(agentId) => onPatch(agentId, { added: true })}
          onOpen={(agentId) => {
            setDialog(null);
            openAgent(agentId);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "usage" ? <UsageDialog agents={agents} access={access} onClose={() => setDialog(null)} /> : null}
      {shareAgent ? (
        <ShareDialog
          key={shareAgent.id}
          agent={shareAgent}
          access={access}
          onShare={(share, managers) => onShare(shareAgent.id, share, managers)}
          onClose={() => go({ share: false })}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar: OpenWork's own places, then the agents. Wide windows show names;
// narrow ones show a rail of avatars, like Grok Bot's compact sidebar.
// ---------------------------------------------------------------------------

const MARK_LABEL: Record<Exclude<Mark, null>, string> = { needs_you: "Needs you", working: "Working", unread: "New" };

function MarkDot({ mark, ring = false }: { mark: Mark; ring?: boolean }) {
  if (!mark) return null;
  const tone = mark === "needs_you" ? "bg-[#E8933A]" : mark === "working" ? "animate-pulse bg-[#0090ff] motion-reduce:animate-none" : "bg-[#2FBE54]";
  return (
    <span className={`block size-2 shrink-0 rounded-full ${tone} ${ring ? "ring-2 ring-[#f9f9fb]" : ""}`}>
      <span className="sr-only">{MARK_LABEL[mark]}</span>
    </span>
  );
}

function Sidebar({ view, listed, markOf, onChat, onAgent, onNew, canAdd, maxAgents, sharedToAdd, onBrowse, onUsage }: {
  view: DesktopView;
  listed: Agent[];
  markOf: (agent: Agent) => Mark;
  onChat: () => void;
  onAgent: (agentId: string) => void;
  onNew: () => void;
  canAdd: boolean;
  maxAgents: number;
  // Agents teammates shared that aren't in the list yet.
  sharedToAdd: number;
  onBrowse: () => void;
  onUsage: () => void;
}) {
  const plus = (rail: boolean) => <AgentsPlus onNew={onNew} canAdd={canAdd} maxAgents={maxAgents} rail={rail} />;
  const selectedId = view.kind === "agent" ? view.agentId : null;
  return (
    <aside className="flex w-[60px] shrink-0 flex-col xl:w-[248px]" aria-label="OpenWork sidebar">
      <div className="flex h-11 shrink-0 items-center justify-center gap-1.5 xl:justify-start xl:gap-2 xl:px-4" aria-hidden>
        <span className="size-2.5 rounded-full bg-[#ff5f57] xl:size-3" />
        <span className="size-2.5 rounded-full bg-[#febc2e] xl:size-3" />
        <span className="size-2.5 rounded-full bg-[#28c840] xl:size-3" />
      </div>
      <nav className="flex flex-col items-center gap-0.5 px-2 xl:items-stretch" aria-label="OpenWork">
        <NavItem icon={SquarePen} label="New session" hint="⌘N" />
        <NavItem icon={Clock3} label="Automations" />
        <NavItem icon={LayoutGrid} label="Library" />
      </nav>
      <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
        <div className="hidden flex-col gap-0.5 xl:flex">
          <GroupLabel>Sessions</GroupLabel>
          <SessionRow label="Set up my agents" selected={view.kind === "chat"} onClick={onChat} testId="desktop-session-setup" />
          <SessionRow label="Plan the Q4 offsite" />
          <SessionRow label="Tidy the release checklist" />
        </div>
        <button
          type="button"
          onClick={onChat}
          aria-label="Set up my agents"
          title="Set up my agents"
          aria-current={view.kind === "chat" ? "page" : undefined}
          data-testid="desktop-session-setup-rail"
          className={`mx-auto grid size-9 place-items-center rounded-xl text-[#60646c] transition-colors hover:bg-[#f0f0f3] xl:hidden ${view.kind === "chat" ? "bg-[#f0f0f3] text-[#1c2024]" : ""}`}
        >
          <Repeat className="size-4" aria-hidden />
        </button>
        <div className="flex flex-col items-center gap-1 xl:items-stretch xl:gap-0.5" data-testid="desktop-agent-threads">
          <div className="hidden xl:block">
            <GroupLabel action={plus(false)}>Agents</GroupLabel>
          </div>
          <span className="my-1 h-px w-6 bg-[#e0e1e6] xl:hidden" aria-hidden />
          {listed.map((agent) => (
            <AgentRow key={agent.id} agent={agent} mark={markOf(agent)} selected={selectedId === agent.id} onClick={() => onAgent(agent.id)} />
          ))}
          <div className="xl:hidden">{plus(true)}</div>
          {listed.length === 0 ? <p className="hidden px-2.5 py-1.5 text-[12px] leading-4 text-[#8b8d98] xl:block">One agent per job. Start one from the +.</p> : null}
          {sharedToAdd > 0 ? (
            <button
              type="button"
              onClick={onBrowse}
              title="Shared with you"
              aria-label={`Shared with you, ${sharedToAdd}`}
              data-testid="desktop-browse-shared"
              className="flex size-10 items-center justify-center gap-2 rounded-xl text-left text-[13px] text-[#8b8d98] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c2024] xl:h-8 xl:w-full xl:justify-start xl:rounded-md xl:px-2"
            >
              <span className="grid size-6 shrink-0 place-items-center"><Users className="size-4" aria-hidden /></span>
              <span className="hidden min-w-0 flex-1 truncate xl:inline">Shared with you</span>
              <span className="hidden text-[11px] xl:inline">{sharedToAdd}</span>
            </button>
          ) : null}
        </div>
      </div>
      <ProfileMenu onUsage={onUsage} />
    </aside>
  );
}

function NavItem({ icon: Icon, label, hint }: { icon: typeof SquarePen; label: string; hint?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="flex size-9 items-center justify-center gap-2 rounded-md text-left text-[13px] text-[#60646c] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c2024] xl:h-8 xl:w-full xl:justify-start xl:px-2.5"
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="hidden min-w-0 flex-1 truncate xl:inline">{label}</span>
      {hint ? <span className="hidden text-[11px] text-[#8b8d98] xl:inline">{hint}</span> : null}
    </button>
  );
}

function GroupLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-6 items-center justify-between gap-2 pl-2.5 pr-1">
      <p className="text-[11px] font-medium text-[#8b8d98]">{children}</p>
      {action}
    </div>
  );
}

function SessionRow({ label, selected = false, onClick, testId }: { label: string; selected?: boolean; onClick?: () => void; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      aria-current={selected ? "page" : undefined}
      className={`flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors ${selected ? "bg-[#f0f0f3] font-medium text-[#1c2024]" : "text-[#60646c] hover:bg-[#f0f0f3] hover:text-[#1c2024]"}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}

// An agent in the roster: its face, its name, and whether it needs you, is working, or has something new.
function AgentRow({ agent, mark, selected, onClick }: { agent: Agent; mark: Mark; selected: boolean; onClick: () => void }) {
  const sub = agent.setup ? "New" : isMine(agent) ? (agent.on ? null : "Paused") : `from ${firstNameOf(agent.owner)}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={agent.name}
      aria-label={`${agent.name}${mark ? `, ${MARK_LABEL[mark].toLowerCase()}` : ""}`}
      aria-current={selected ? "page" : undefined}
      data-testid={`desktop-thread-${agent.id}`}
      data-dot={mark ?? "none"}
      className={`relative flex size-10 items-center justify-center gap-2 rounded-xl text-left text-[13px] transition-colors xl:h-8 xl:w-full xl:justify-start xl:rounded-md xl:px-2 ${selected ? "bg-[#f0f0f3] font-medium text-[#1c2024]" : "text-[#60646c] hover:bg-[#f0f0f3] hover:text-[#1c2024]"}`}
    >
      <span className="relative">
        <AgentAvatar agent={agent} size={24} />
        <span className="absolute -right-0.5 -top-0.5 xl:hidden"><MarkDot mark={mark} ring /></span>
      </span>
      <span className="hidden min-w-0 flex-1 truncate xl:inline">{agent.name}</span>
      {sub ? <span className="hidden shrink-0 text-[11px] font-normal text-[#8b8d98] xl:inline">{sub}</span> : null}
      <span className="hidden xl:inline-flex xl:items-center xl:gap-1.5">
        {mark === "needs_you" ? <span className="text-[11px] font-normal text-[#9a4a00]">Needs you</span> : null}
        <MarkDot mark={mark} />
      </span>
    </button>
  );
}

const MENU_ITEM = "flex h-8 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-[13px] text-[#1c2024] outline-none data-[highlighted]:bg-[#f0f0f3]";
const MENU_POPUP = "min-w-[208px] rounded-xl border border-[#e0e1e6] bg-white p-1 shadow-[0_8px_24px_rgba(15,23,42,0.08)] outline-none";

// Where an agent starts: one click, and you are in its chat.
function AgentsPlus({ onNew, canAdd, maxAgents, rail = false }: { onNew: () => void; canAdd: boolean; maxAgents: number; rail?: boolean }) {
  const label = canAdd ? "New agent" : `Your admin allows ${maxAgents} agents. Remove one to make another.`;
  return (
    <button
      type="button"
      onClick={onNew}
      disabled={!canAdd}
      aria-label={label}
      title={label}
      data-testid={rail ? "desktop-agents-plus-rail" : "desktop-agents-plus"}
      className={`grid shrink-0 place-items-center text-[#60646c] outline-none transition-colors hover:bg-[#f0f0f3] hover:text-[#1c2024] focus-visible:bg-[#f0f0f3] disabled:cursor-not-allowed disabled:opacity-40 ${rail ? "size-10 rounded-xl" : "size-6 rounded-md"}`}
    >
      <Plus className={rail ? "size-4" : "size-3.5"} aria-hidden />
    </button>
  );
}

// The member's own menu. Usage shows spend by agent, like Grok Bot's "By Bot" view.
function ProfileMenu({ onUsage }: { onUsage: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label="Your account"
        data-testid="desktop-profile"
        className="flex shrink-0 items-center justify-center gap-2.5 border-t border-[#e0e1e6] px-3 py-2.5 text-left outline-none transition-colors hover:bg-[#f0f0f3] xl:justify-start"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#011627] text-[10px] font-semibold tracking-wider text-white">{MEMBER.initials}</span>
        <span className="hidden min-w-0 flex-col xl:flex">
          <span className="truncate text-[13px] font-medium leading-4">{MEMBER.name}</span>
          <span className="truncate text-[11px] leading-4 text-[#8b8d98]">OpenWork Cloud · Sample org</span>
        </span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Menu.Popup className={MENU_POPUP} style={{ fontFamily: APP_FONT }}>
            <Menu.Item onClick={onUsage} data-testid="desktop-usage" className={MENU_ITEM}>
              <BarChart3 className="size-4 shrink-0 text-[#60646c]" aria-hidden />
              Usage
            </Menu.Item>
            <Menu.Item className={MENU_ITEM}>
              <Settings2 className="size-4 shrink-0 text-[#60646c]" aria-hidden />
              Settings
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function UsageDialog({ agents, access, onClose }: { agents: Agent[]; access: Access; onClose: () => void }) {
  const used = agents.filter(usedByMe).sort((left, right) => right.spentMicro - left.spentMicro);
  return (
    <Dialog title="Usage" onClose={onClose} testId="usage-dialog" wide>
      <div className="flex flex-col gap-4">
        <MonthSpend agents={agents} access={access} />
        <section className="flex flex-col" data-testid="usage-by-agent">
          <h3 className="pb-1 text-[12px] font-medium text-[#8b8d98]">By agent</h3>
          {used.map((agent) => (
            <div key={agent.id} className="flex min-h-10 items-center gap-3 border-t border-[#f3f4f6] py-1.5">
              <AgentAvatar agent={agent} size={20} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-[#1c2024]">{agent.name}</span>
              <span className="shrink-0 text-[12px] text-[#8b8d98]">{agent.paidBy === "org" ? "Org pays" : isMine(agent) ? "You pay" : `From ${personName(agent.owner)}`}</span>
              <span className="w-16 shrink-0 text-right font-mono text-[13px] tabular-nums text-[#1c2024]">{formatWorkbotCost(agent.spentMicro)}</span>
            </div>
          ))}
        </section>
      </div>
    </Dialog>
  );
}

// What lands in the person's Slack, from the Workbot app.
function SlackMessage({ when, text }: { when: string; text: string }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-[#e0e1e6] bg-white p-3" data-testid="slack-message">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-[#e0e1e6] bg-white">
        <img src="/openwork-mark.svg" alt="" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="flex items-center gap-1.5 text-[13px] leading-5">
          <span className="font-semibold text-[#1c2024]">Workbot</span>
          <span className="rounded bg-[#f0f0f3] px-1 text-[10px] font-medium leading-4 text-[#60646c]">APP</span>
          <span className="text-[12px] text-[#8b8d98]">{when}</span>
        </p>
        <p className="text-[14px] leading-5 text-[#1c2024]">{text}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting agents up by asking
// ---------------------------------------------------------------------------

function stagesOf(turn: ChatTurn): number {
  return turn.steps.length + 1 + (turn.card ? 1 : 0);
}

function awaitsAnswer(card: ChatCard | null): boolean {
  if (!card) return false;
  if (card.kind === "proposal") return card.state === "draft";
  if (card.kind === "permission" || card.kind === "share") return card.state === "ask";
  return false;
}

function SetupChat({ turns, agents, access, onAsk, onCard, onOpenThread, onOpenShare, onOpenAgents }: {
  turns: ChatTurn[];
  agents: Agent[];
  access: Access;
  onAsk: (prompt: string) => void;
  onCard: (turnId: string, accept: boolean) => void;
  onOpenThread: (agentId: string) => void;
  onOpenShare: (agentId: string) => void;
  onOpenAgents: () => void;
}) {
  const [text, setText] = useState("");
  const last = turns[turns.length - 1] ?? null;
  const lastId = last?.id ?? null;
  const total = last ? stagesOf(last) : 0;
  // A turn that was already here when the chat opened is shown whole; a new one plays out step by step.
  const [reveal, setReveal] = useState(() => (last ? { id: last.id, count: stagesOf(last) } : null));
  const shown = reveal !== null && reveal.id === lastId ? reveal.count : 0;
  const working = lastId !== null && shown < total;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (lastId === null || shown >= total) return;
    const timer = window.setTimeout(() => setReveal({ id: lastId, count: shown + 1 }), shown === 0 ? 420 : 520);
    return () => window.clearTimeout(timer);
  }, [lastId, shown, total]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight });
  }, [turns.length, shown]);

  const asked = new Set(turns.map((turn) => turn.prompt));
  const usable = (prompt: string) => SAMPLE_NAMES.every((name) => !prompt.includes(name) || agents.some((agent) => agent.name === name));
  const next = STORY.find((prompt) => !asked.has(prompt) && usable(prompt)) ?? null;
  const extras = CHAT_EXTRAS.filter((prompt) => !asked.has(prompt) && usable(prompt)).slice(0, next ? 2 : 3);
  const waiting = awaitsAnswer(last?.card ?? null);

  const send = (prompt: string) => {
    if (working) return;
    setText("");
    onAsk(prompt.trim());
  };

  return (
    <>
      <PaneHeader title="Set up my agents">
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[#8b8d98]">
          <Plug className="size-3.5" aria-hidden />
          OpenWork Cloud connected
        </span>
      </PaneHeader>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="chat-scroll">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-6">
          {turns.length === 0 ? (
            <div className="flex flex-col gap-2 pt-10" data-testid="chat-empty">
              <h2 className="text-[20px] font-semibold leading-7 tracking-[-0.2px] text-[#1c2024]">Ask for an agent</h2>
              <p className="max-w-[560px] text-[14px] leading-6 text-[#60646c]">
                Say what it should do. It gets its own conversation and asks before it changes anything in your apps. You can also start one from the + beside Agents.
              </p>
            </div>
          ) : null}
          {turns.map((turn, index) => (
            <Turn
              key={turn.id}
              turn={turn}
              count={index === turns.length - 1 ? shown : stagesOf(turn)}
              agents={agents}
              access={access}
              onCard={(accept) => onCard(turn.id, accept)}
              onOpenThread={onOpenThread}
              onOpenShare={onOpenShare}
              onOpenAgents={onOpenAgents}
            />
          ))}
        </div>
      </div>
      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-2.5">
          {working ? null : waiting ? (
            <p className="px-2 text-[12px] leading-4 text-[#8b8d98]" data-testid="chat-waiting">Answer the card above to go on, or ask for something else.</p>
          ) : (
            <div className="flex flex-wrap gap-2" data-testid="chat-suggestions">
              {next ? (
                <button
                  type="button"
                  onClick={() => send(next)}
                  data-testid="chat-next"
                  className="max-w-full truncate rounded-full border border-[#1c2024] bg-[#fcfcfd] px-3 py-1.5 text-left text-[13px] font-medium text-[#1c2024] transition-colors hover:bg-[#f0f0f3]"
                >
                  {next}
                </button>
              ) : null}
              {extras.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => send(prompt)}
                  data-testid="chat-extra"
                  className="max-w-full truncate rounded-full border border-[#e0e1e6] bg-[#fcfcfd] px-3 py-1.5 text-left text-[13px] text-[#60646c] transition-colors hover:bg-[#f0f0f3] hover:text-[#1c2024]"
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
          <Composer value={text} onChange={setText} onSubmit={() => send(text)} placeholder="Describe your task..." disabled={working} />
        </div>
      </div>
    </>
  );
}

function Turn({ turn, count, agents, access, onCard, onOpenThread, onOpenShare, onOpenAgents }: {
  turn: ChatTurn;
  count: number;
  agents: Agent[];
  access: Access;
  onCard: (accept: boolean) => void;
  onOpenThread: (agentId: string) => void;
  onOpenShare: (agentId: string) => void;
  onOpenAgents: () => void;
}) {
  const steps = turn.steps.slice(0, count);
  const replied = count > turn.steps.length;
  const done = count >= stagesOf(turn);
  return (
    <div className="flex flex-col gap-3" data-testid="chat-turn" data-stage={done ? "done" : "working"}>
      <UserBubble>{turn.prompt}</UserBubble>
      {steps.length > 0 ? (
        <div className="flex flex-col">
          {steps.map((step) => <ActivityLine key={step.key} step={step} />)}
        </div>
      ) : null}
      {replied ? <p className="text-[14px] leading-6 text-[#1c2024]" data-testid="chat-reply">{turn.reply}</p> : <Working label={steps.length === 0 ? "Thinking" : "Working"} />}
      {done && turn.card ? (
        <ChatCardView card={turn.card} agents={agents} access={access} onCard={onCard} onOpenThread={onOpenThread} onOpenShare={onOpenShare} onOpenAgents={onOpenAgents} />
      ) : null}
    </div>
  );
}

// One thing the assistant did. The tool call behind it is there for anyone who wants it.
function ActivityLine({ step }: { step: ChatStep }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col" data-testid="chat-step">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="group/line flex w-fit max-w-full items-center gap-1.5 rounded-md py-1 text-left text-[14px] leading-5 text-[#60646c] transition-colors hover:text-[#1c2024]"
      >
        <span className="shrink-0">{step.label}</span>
        {step.detail ? <span className="truncate text-[#8b8d98]">{step.detail}</span> : null}
        <ChevronRight className={`size-3.5 shrink-0 text-[#8b8d98] transition-[transform,opacity] duration-150 motion-reduce:transition-none ${open ? "rotate-90 opacity-100" : "opacity-0 group-hover/line:opacity-100 group-focus-visible/line:opacity-100"}`} aria-hidden />
      </button>
      {open ? (
        <dl className="mb-2 mt-1 grid gap-x-4 gap-y-2 rounded-xl border border-[#e0e1e6] bg-[#f9f9fb] p-3 text-[12px] leading-5 sm:grid-cols-[64px_minmax(0,1fr)]" data-testid="chat-step-detail">
          <dt className="text-[#8b8d98]">Tool</dt>
          <dd className="font-mono text-[#1c2024]">{step.tool}</dd>
          <dt className="text-[#8b8d98]">Sent</dt>
          <dd><pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[#60646c]">{step.input}</pre></dd>
          <dt className="text-[#8b8d98]">Got back</dt>
          <dd><pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[#60646c]">{step.result}</pre></dd>
        </dl>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards. Anything that gives an agent more reach waits for a click here.
// ---------------------------------------------------------------------------

// One agent, used by several people. A manager is a person or a whole team.
// People and teams, by the name a card shows.
function namesOf(ids: string[], short = false): string[] {
  return ids.flatMap((id) => {
    const person = PEOPLE.find((entry) => entry.id === id);
    if (person) return [short ? firstNameOf(id) : person.name];
    const team = TEAMS.find((entry) => entry.id === id);
    return team ? [team.name] : [];
  });
}

function managerLines(agent: Agent | null): string[] {
  return [
    "A manager can change what it does, its routines and which tools it uses. That changes it for everyone who uses it.",
    "They use it with their own accounts, like everyone else.",
    "Only you can share it or remove it.",
    agent?.paidBy === "org" ? "The org's agent budget still pays for everyone's use." : "Each person's use still counts toward their own limit.",
  ];
}

function shareLines(agent: Agent | null, managers: string[]): string[] {
  const named = namesOf(managers);
  return [
    "They get the same agent. They can ask it things, or turn on its routines for themselves.",
    "It works with each person's own accounts. Never yours.",
    named.length > 0
      ? `${listWords(named)} can change what it does, as ${named.length === 1 ? "a manager" : "managers"}. Everyone else only uses it.`
      : "Everyone joins as a collaborator: they use it, and only you can change what it does.",
    "They never see your runs. Only you can share it or remove it.",
    agent?.paidBy === "org" ? "The org's agent budget pays for everyone's use." : "Each person's use counts toward their own limit.",
  ];
}

function ChatCardView({ card, agents, access, onCard, onOpenThread, onOpenShare, onOpenAgents }: {
  card: ChatCard;
  agents: Agent[];
  access: Access;
  onCard: (accept: boolean) => void;
  onOpenThread: (agentId: string) => void;
  onOpenShare: (agentId: string) => void;
  onOpenAgents: () => void;
}) {
  if (card.kind === "proposal") {
    const { draft } = card;
    const uses = draftUses(draft);
    const made = card.agentId !== null && agents.some((agent) => agent.id === card.agentId) ? card.agentId : null;
    return (
      <CardShell
        icon={Repeat}
        title={draft.name}
        testId="chat-card-proposal"
        dataState={card.state}
        state={card.state === "draft" ? "Draft" : card.state === "on" ? "On" : "Not created"}
        footer={card.state === "draft" ? (
          <>
            <AppButton onClick={() => onCard(true)} testId="chat-card-accept">Create and turn on</AppButton>
            <AppButton variant="quiet" onClick={() => onCard(false)} testId="chat-card-decline">Not now</AppButton>
          </>
        ) : card.state === "on" ? (
          <>
            <span className="min-w-0 flex-1 text-[13px] text-[#60646c]">{`${nextRunLine(draft.schedule)}.`}</span>
            {made ? <AppButton variant="secondary" onClick={() => onOpenThread(made)} testId="chat-card-thread">Open its conversation</AppButton> : null}
          </>
        ) : undefined}
      >
        <div className="space-y-1 text-[14px] leading-5 text-[#60646c]">
          <p className="whitespace-pre-wrap text-[#1c2024]">{draft.instructions}</p>
          <p>{`${scheduleLine(draft.schedule)}. It reports back in its own conversation.`}</p>
        </div>
        <CardDetails>
          {uses.length === 0 ? <p>It uses no apps yet. It asks the first time it needs one.</p> : null}
          {uses.map(({ connector, tools }) => (
            <p key={connector.id} className="flex items-center gap-2" data-testid={`chat-card-uses-${connector.id}`} data-level={presetOf(connector, tools)} data-tools={tools.join(",")}>
              <ConnectorLogo name={connector.name} url={connector.url} size="xs" />
              <span className="text-[#1c2024]">{connector.name}</span>
              <span>{accessWord(connector, tools)}</span>
            </p>
          ))}
          <p>{`Can spend up to ${formatWorkbotCost(draft.budgetMicro)} a month, from your own limit.`}</p>
          <p>Works in OpenWork Cloud, also when this computer is off.</p>
          <p>Model: Auto.</p>
          <p>Stays quiet when there is nothing to tell you.</p>
          <p>Saved as <code className="font-mono text-[12px] text-[#1c2024]">{`agents/${agentSlug(draft.name)}.md`}</code>.</p>
          {draft.capped.map((name) => <p key={name}>{`Your admin blocks some ${name} tools for every agent. Those are left out.`}</p>)}
          {uses.map(({ connector, tools }) => <ToolList key={connector.id} label={`${connector.name} tools`} tools={tools} />)}
        </CardDetails>
      </CardShell>
    );
  }

  if (card.kind === "permission") {
    const agent = agents.find((entry) => entry.id === card.agentId) ?? null;
    const connector = connectorById(card.connector);
    const name = agent?.name ?? "This agent";
    const before = (agent?.tools[card.connector] ?? []).filter((tool) => !card.tools.includes(tool));
    const one = card.tools.length === 1 ? card.tools[0] ?? "" : null;
    const stopped = access.blocked[card.connector];
    return (
      <CardShell
        icon={ShieldCheck}
        title={one !== null ? `Let ${name} use “${toolLabel(one)}” in ${connector.name}` : `Let ${name} use ${card.tools.length} more ${connector.name} tools`}
        testId="chat-card-permission"
        dataState={card.state}
        state={card.state === "ask" ? "Needs your OK" : card.state === "allowed" ? "Allowed" : "Not allowed"}
        footer={card.state === "ask" ? (
          <>
            <AppButton onClick={() => onCard(true)} testId="chat-card-accept">{one !== null ? "Allow this tool" : `Allow ${card.tools.length} tools`}</AppButton>
            <AppButton variant="quiet" onClick={() => onCard(false)} testId="chat-card-decline">Not now</AppButton>
          </>
        ) : card.state === "allowed" ? (
          <span className="text-[13px] text-[#60646c]">It applies from the next run.</span>
        ) : undefined}
      >
        <div className="flex flex-col gap-2">
          <CardRow label="Today">{before.length === 0 ? `Off. It does not use ${connector.name}.` : `${accessWord(connector, before)}. ${toolsLine(connector, before)}`}</CardRow>
          <CardRow label="Adds">
            <span className="flex flex-col gap-0.5" data-testid="chat-card-tools" data-tools={card.tools.join(",")}>
              {card.tools.map((tool) => (
                <span key={tool} className="flex items-baseline gap-2">
                  <span>{toolLabel(tool)}</span>
                  <span className="text-[12px] text-[#8b8d98]">{isWriteTool(connector, tool) ? "Writes" : "Reads"}</span>
                </span>
              ))}
            </span>
          </CardRow>
          <CardRow label="Stays blocked">{`Everything else in ${connector.name} it doesn't have today.`}</CardRow>
          {card.addInstructions ? <CardRow label="Also adds">{`To its instructions: “${card.addInstructions}”`}</CardRow> : null}
        </div>
        <CardDetails>
          <ToolList label="Tools it gains" tools={card.tools} />
          {stopped.length > 0 ? <ToolList label="Blocked by your admin" tools={stopped} /> : null}
          <ToolList label="Never allowed" tools={connector.neverTools} />
        </CardDetails>
      </CardShell>
    );
  }

  if (card.kind === "share") {
    const agent = agents.find((entry) => entry.id === card.agentId) ?? null;
    const owner = agent?.owner ?? "dana";
    const count = sharedPeople(card.share, owner).length;
    const who = card.share.orgWide ? "Everyone in the organization" : shareTargets(card.share, owner);
    // Giving someone the manager role is its own card: it changes who can change the agent, not who has it.
    const promoted = card.promote.length > 0;
    const role = card.promote.length === 1 && PEOPLE.some((person) => person.id === card.promote[0]) ? "a manager" : "managers";
    const done = promoted ? "Role changed" : "Shared";
    const kept = promoted ? "Role not changed" : "Not shared";
    return (
      <CardShell
        icon={Users}
        title={promoted ? `Make ${listWords(namesOf(card.promote))} ${role}` : `Share ${agent?.name ?? "this agent"}`}
        testId="chat-card-share"
        dataState={card.state}
        state={card.state === "ask" ? "Needs your OK" : card.state === "shared" ? done : kept}
        footer={card.state === "ask" ? (
          <>
            <AppButton onClick={() => onCard(true)} testId="chat-card-accept">
              {promoted ? `Make ${listWords(namesOf(card.promote, true))} ${role}` : `Share with ${peopleLabel(count)}`}
            </AppButton>
            <AppButton variant="quiet" onClick={() => onCard(false)} testId="chat-card-decline">Not now</AppButton>
          </>
        ) : card.state === "shared" ? (
          <>
            <span className="min-w-0 flex-1 text-[13px] text-[#60646c]">
              {promoted ? "They change it from their own thread with it, or its settings." : "Its routines are off for them until they turn them on."}
            </span>
            {agent && isMine(agent) ? <AppButton variant="secondary" onClick={() => onOpenShare(card.agentId)} testId="chat-card-sharing">Who has access</AppButton> : null}
          </>
        ) : undefined}
      >
        <div className="flex flex-col gap-2">
          {promoted ? <CardRow label="Agent">{agent?.name ?? "This agent"}</CardRow> : null}
          <CardRow label={promoted ? "Shared with" : "With"}>{`${who} (${peopleLabel(count)})`}</CardRow>
          <CardRow label="What it means">
            <span className="flex flex-col gap-1">
              {(promoted ? managerLines(agent) : shareLines(agent, card.managers)).map((line) => <span key={line}>{line}</span>)}
            </span>
          </CardRow>
        </div>
      </CardShell>
    );
  }

  if (card.kind === "run") {
    const exists = agents.some((agent) => agent.id === card.agentId);
    return (
      <CardShell
        icon={Play}
        title={`${card.agentName} ran`}
        testId="chat-card-run"
        dataState={card.run.outcome}
        state={card.run.when}
        footer={(
          <>
            <span className="min-w-0 flex-1 text-[13px] text-[#60646c]">{card.run.costMicro > 0 ? `This run cost ${formatWorkbotCost(card.run.costMicro)}.` : "This run cost nothing."}</span>
            {exists ? <AppButton variant="secondary" onClick={() => onOpenThread(card.agentId)} testId="chat-card-thread">Open its conversation</AppButton> : null}
          </>
        )}
      >
        <RunSteps steps={card.run.steps} />
        <SlackRunMessage run={card.run} />
      </CardShell>
    );
  }

  return (
    <CardShell
      icon={CircleDollarSign}
      title="Agent spend this month"
      testId="chat-card-spend"
      dataState="shown"
      state={formatWorkbotCost(card.totalMicro + card.orgMicro)}
      footer={(
        <>
          <span className="min-w-0 flex-1 text-[13px] text-[#60646c]" data-testid="chat-card-paid">
            {card.orgMicro > 0
              ? `${formatWorkbotCost(card.totalMicro)} from your own limit, ${formatWorkbotCost(card.orgMicro)} from the org's agent budget.`
              : "All of it counts toward your own limit."}
          </span>
          <AppButton variant="secondary" onClick={onOpenAgents} testId="chat-card-agents">See usage</AppButton>
        </>
      )}
    >
      <ul className="flex flex-col divide-y divide-[#f3f4f6]">
        {card.rows.map((row) => (
          <li key={row.id} className="flex items-center gap-3 py-2 text-[14px] leading-5" data-paid-by={row.paidBy}>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-[#1c2024]">{row.name}</span>
              <span className="truncate text-[12px] leading-4 text-[#8b8d98]">{row.note}</span>
            </span>
            {row.over ? <span className="shrink-0 rounded-full bg-[#fff1e0] px-2 text-[12px] leading-5 text-[#9a4a00]">Over budget</span> : null}
            <span className="shrink-0 font-mono text-[13px] tabular-nums text-[#1c2024]">
              {row.budgetMicro === null ? formatWorkbotCost(row.spentMicro) : `${formatWorkbotCost(row.spentMicro)} of ${formatWorkbotCost(row.budgetMicro)}`}
            </span>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function SlackRunMessage({ run }: { run: AgentRun }) {
  if (run.outcome === "sent") return <SlackMessage when={run.when} text={run.summary} />;
  if (run.outcome === "quiet") return <p className="text-[14px] leading-5 text-[#60646c]">{`Nothing to tell you, so no message. ${run.summary}`}</p>;
  return <p className="text-[14px] leading-5 text-[#9a4a00]">{run.summary}</p>;
}
