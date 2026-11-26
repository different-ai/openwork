"use client";

import { useEffect, useRef, useState } from "react";
import { DenSegmented } from "../../(den)/_components/ui/segmented";
import type { AccessDraft } from "../../(den)/dashboard/_components/access-summary";
import { ADMIN, AdminDashboard, type AdminTab } from "./den";
import { DesktopApp, type DesktopView } from "./desktop";
import {
  type Access,
  type Agent,
  type AgentSession,
  type ChatCard,
  type ChatTurn,
  type ConnectorId,
  type RunAsk,
  type Scenario,
  type Schedule,
  DEFAULT_ACCESS,
  DEFAULT_CONNECTED,
  ME,
  MEMBER,
  ASK_EXPIRES_MS,
  agentFromDraft,
  canChange,
  applyRun,
  changesTheAgent,
  clockNow,
  connectorById,
  copyAgent,
  draftAgent,
  giveJob,
  inMyList,
  interpretChat,
  isMemoryQuestion,
  isMine,
  keepManagers,
  noteAsksFirst,
  sampleAgents,
  settleRun,
  startAgent,
  startSession,
  stoppedRun,
  toolsForLevel,
} from "./model";

// Prototype only: every screen here runs on sample data held in memory.

// Two people, two places. A member does everything about their agents in the
// OpenWork app. An admin sets the rules for everyone in the Cloud dashboard.
type Viewer = "member" | "admin";

const VIEWER_NOTE: Record<Viewer, string> = {
  member: `You are ${MEMBER.name}, a member. Everything about your agents is here, in the OpenWork app.`,
  admin: `You are ${ADMIN.name}, an admin. These rules apply to every member's agents.`,
};

// At the start one agent's routine is waiting on an OK, so the sidebar shows an agent that needs you.
function seedSessions(agents: Agent[]): AgentSession[] {
  const agent = agents.find((entry) => entry.id === "agent-notes");
  const routine = agent?.routines[0];
  if (!agent || !routine) return [];
  const now = Date.now();
  const session = startSession(agent, DEFAULT_ACCESS, DEFAULT_CONNECTED, { id: "run-seed", when: clockAt(now - 6 * 60 * 1000), kind: "routine", routine, nowMs: now - 6 * 60 * 1000, working: true });
  return [{ ...session, state: session.ask ? "needs_you" : "working", shown: session.ask ? session.ask.at : session.run.steps.length }];
}

function clockAt(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(ms));
}

// Up to the admin's number per agent work at once. The rest wait their turn, oldest first.
function promote(sessions: AgentSession[], access: Access): AgentSession[] {
  const busy: Record<string, number> = {};
  for (const session of sessions) {
    if (session.kind !== "ask" && session.state !== "waiting") busy[session.agentId] = (busy[session.agentId] ?? 0) + 1;
  }
  return sessions.map((session) => {
    if (session.state !== "waiting" || (busy[session.agentId] ?? 0) >= access.atOnce) return session;
    busy[session.agentId] = (busy[session.agentId] ?? 0) + 1;
    return { ...session, state: "working" };
  });
}

// Everything read, except the newest run of one agent, so a fresh message shows in the sidebar.
function startingSeen(agents: Agent[]): Record<string, number> {
  const fresh = agents.find((agent) => agent.on && agent.runs.length > 0);
  return Object.fromEntries(agents.map((agent) => [agent.id, agent.runs.length - (agent.id === fresh?.id ? 1 : 0)]));
}

function pendingProposalName(turns: ChatTurn[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const card = turns[index]?.card;
    if (card?.kind === "proposal" && card.state === "draft") return card.draft.name;
  }
  return null;
}

export default function AgentsPrototypePage() {
  const [viewer, setViewer] = useState<Viewer>("member");
  const [adminTab, setAdminTab] = useState<AdminTab>("rules");
  const [scenario, setScenario] = useState<Scenario>("sample");
  const [agents, setAgents] = useState<Agent[]>(sampleAgents);
  const [access, setAccess] = useState<Access>(DEFAULT_ACCESS);
  const [connected, setConnected] = useState<Record<ConnectorId, boolean>>(DEFAULT_CONNECTED);
  const [removed, setRemoved] = useState<Agent | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [contextId, setContextId] = useState<string | null>(null);
  const [seenRuns, setSeenRuns] = useState<Record<string, number>>(() => startingSeen(sampleAgents()));
  const [desktopView, setDesktopView] = useState<DesktopView>({ kind: "chat" });
  const [sessions, setSessions] = useState<AgentSession[]>(() => seedSessions(sampleAgents()));
  const [nowMs, setNowMs] = useState(() => Date.now());
  const counter = useRef(0);
  // The latest of each, for the clock below. It works out every change first, then sets state once.
  const live = useRef({ agents, sessions, access });
  live.current = { agents, sessions, access };

  const nextId = (prefix: string) => {
    counter.current += 1;
    return `${prefix}-${counter.current}`;
  };

  // Ends sessions and puts their runs in the agents' conversations. Waiting ones then take the free slots.
  const finish = (done: { session: AgentSession; answer: RunAsk["state"] | null; stopped?: boolean }[], rest: AgentSession[]) => {
    const current = live.current;
    let nextAgents = current.agents;
    for (const { session, answer, stopped } of done) {
      nextAgents = nextAgents.map((agent) => {
        if (agent.id !== session.agentId) return agent;
        const run = stopped ? stoppedRun(session) : settleRun(agent, session, answer);
        return applyRun(agent, run);
      });
    }
    setAgents(nextAgents);
    setSessions(promote(rest, current.access));
  };

  // The clock: every beat each working session shows one more step, then reports back or stops to ask.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      const { sessions: current } = live.current;
      if (current.length === 0) return;
      const done: { session: AgentSession; answer: RunAsk["state"] | null }[] = [];
      const rest: AgentSession[] = [];
      let changed = false;
      for (const session of current) {
        if (session.state === "needs_you" && session.ask?.background && now - session.ask.raisedMs > ASK_EXPIRES_MS) {
          done.push({ session, answer: "expired" });
          changed = true;
        } else if (session.state !== "working") {
          rest.push(session);
        } else if (session.ask && session.shown >= session.ask.at) {
          // It got to the first thing it may not do yet, so it stops there and asks.
          rest.push({ ...session, state: "needs_you", ask: { ...session.ask, raisedMs: now } });
          changed = true;
        } else if (session.shown < session.run.steps.length) {
          rest.push({ ...session, shown: session.shown + 1 });
          changed = true;
        } else {
          done.push({ session, answer: null });
          changed = true;
        }
      }
      if (!changed) return;
      if (done.length > 0) finish(done, rest);
      else setSessions(rest);
    }, 900);
    return () => window.clearInterval(timer);
  }, []);

  const begin = (agentId: string, kind: AgentSession["kind"], options: { routineId?: string; asked?: string; as?: Agent } = {}) => {
    const agent = options.as ?? agents.find((entry) => entry.id === agentId);
    if (!agent) return;
    const routine = agent.routines.find((entry) => entry.id === options.routineId);
    const busy = sessions.filter((session) => session.agentId === agentId && session.kind !== "ask" && session.state !== "waiting").length;
    const session = startSession(agent, access, connected, {
      id: nextId("run"),
      when: clockNow(),
      kind,
      routine,
      asked: options.asked,
      nowMs: Date.now(),
      working: kind === "ask" || busy < access.atOnce,
    });
    setSessions((current) => [...current, session]);
  };

  const readingId = viewer === "member" && desktopView.kind === "agent" ? desktopView.agentId : null;
  const unreadIds = agents
    .filter((agent) => inMyList(agent, access) && agent.id !== readingId && agent.runs.length > (seenRuns[agent.id] ?? 0))
    .map((agent) => agent.id);

  // Leaving a thread marks what was in it as read.
  const markThreadRead = () => {
    const agent = agents.find((entry) => entry.id === readingId);
    if (agent) setSeenRuns((current) => ({ ...current, [agent.id]: agent.runs.length }));
  };

  const changeDesktopView = (next: DesktopView) => {
    markThreadRead();
    setDesktopView(next);
  };

  const changeViewer = (next: Viewer) => {
    markThreadRead();
    setViewer(next);
  };

  const patchAgent = (id: string, patch: Partial<Agent>) => {
    setAgents((current) => current.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
  };

  const patchWith = (id: string, change: (agent: Agent) => Partial<Agent>) => {
    setAgents((current) => current.map((agent) => (agent.id === id ? { ...agent, ...change(agent) } : agent)));
  };

  // "Run now" runs the agent once on its instructions, in a fresh session. Testing a routine runs that routine.
  const runAgent = (id: string, routineId?: string) => begin(id, routineId ? "routine" : "run", { routineId });

  const stopSession = (sessionId: string) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    const rest = sessions.filter((entry) => entry.id !== sessionId);
    if (session.state === "waiting") setSessions(rest);
    else finish([{ session, answer: null, stopped: true }], rest);
  };

  // Yes lets it carry on from where it stopped. "Always allow" also keeps those tools for next time. No ends the run there.
  const answerAsk = (sessionId: string, answer: RunAsk["state"]) => {
    const session = sessions.find((entry) => entry.id === sessionId);
    const agent = agents.find((entry) => entry.id === session?.agentId);
    if (!session || !agent || !session.ask) return;
    if (answer !== "allowed" && answer !== "always") {
      finish([{ session, answer }], sessions.filter((entry) => entry.id !== sessionId));
      return;
    }
    if (answer === "always") {
      const tools = { ...agent.tools };
      let sessionTools = agent.openwork.sessions;
      for (const item of session.ask.items) {
        if (item.connector === "openwork") sessionTools = [...sessionTools, item.tool];
        else tools[item.connector] = [...tools[item.connector], item.tool];
      }
      patchAgent(agent.id, { tools, openwork: { ...agent.openwork, sessions: sessionTools } });
    }
    const run = settleRun(agent, session, answer);
    setSessions((current) => current.map((entry) => (entry.id === sessionId ? { ...entry, run, ask: null, state: "working" } : entry)));
  };

  // A message in the conversation. While it works, a message goes first and changes its course.
  const sendTo = (agentId: string, text: string) => {
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) return;
    const working = sessions.find((session) => session.agentId === agentId && session.kind === "ask");
    if (working) {
      setSessions((current) => current.map((session) => (session.id === working.id ? { ...session, heard: [...session.heard, text] } : session)));
      return;
    }
    if (isMemoryQuestion(text)) {
      patchAgent(agentId, { memoryChecks: [...agent.memoryChecks, agent.runs.length] });
      return;
    }
    if (/\brun\b|\bcheck now\b/i.test(text)) {
      runAgent(agentId);
      return;
    }
    if (!canChange(agent) || text.endsWith("?")) {
      begin(agentId, "ask", { asked: text });
      return;
    }
    addNote(agentId, text);
  };

  // A reply in a thread is about that run only. Asking it to change for good is taken to the conversation.
  const replyInThread = (agentId: string, runId: string, text: string) => {
    if (!text) return;
    const mineId = nextId("reply");
    const theirsId = nextId("reply");
    const agent = agents.find((entry) => entry.id === agentId);
    const run = agent?.runs.find((entry) => entry.id === runId);
    const lasting = changesTheAgent(text);
    const answer = lasting
      ? "That would change how I work every time, so it belongs in our conversation. In a thread I only talk about this run."
      : `About this run only: ${run?.steps[0]?.label.toLowerCase() ?? "I went through what I could see"}, and nothing else came up. Want me to look closer at one of them?`;
    patchWith(agentId, (current) => ({ replies: [...current.replies, { id: mineId, runId, from: ME, text }] }));
    window.setTimeout(() => {
      patchWith(agentId, (current) => ({ replies: [...current.replies, { id: theirsId, runId, from: "agent", text: answer, move: lasting ? { text, done: false } : undefined }] }));
    }, 700);
  };

  const moveReply = (agentId: string, replyId: string) => {
    const agent = agents.find((entry) => entry.id === agentId);
    const reply = agent?.replies.find((entry) => entry.id === replyId);
    if (!agent || !reply?.move || reply.move.done) return;
    const said = reply.move.text;
    patchWith(agentId, (current) => ({ replies: current.replies.map((entry) => (entry.id === replyId && entry.move ? { ...entry, move: { ...entry.move, done: true } } : entry)) }));
    addNote(agentId, said);
  };

  const removeAgent = (agent: Agent) => {
    setAgents((current) => current.filter((entry) => entry.id !== agent.id));
    setRemoved(agent);
    setSessions((current) => current.filter((session) => session.agentId !== agent.id));
    if (desktopView.kind === "agent" && desktopView.agentId === agent.id) setDesktopView({ kind: "chat" });
  };

  const undoRemove = () => {
    if (!removed) return;
    setAgents((current) => [...current, removed]);
    setRemoved(null);
  };

  // A copy is yours to change, so it opens with its settings showing.
  const makeCopy = (agent: Agent) => {
    if (agents.filter(isMine).length >= access.maxAgents) return;
    const id = nextId("agent");
    setAgents((current) => [...current, copyAgent(agent, id, access)]);
    markThreadRead();
    setDesktopView({ kind: "agent", agentId: id, panel: "settings", thread: null });
  };

  // A new agent is a chat with nothing in it yet. Its first message is its job, and it names itself from that.
  const createAgent = () => {
    if (agents.filter(isMine).length >= access.maxAgents) return;
    const id = nextId("agent");
    setAgents((current) => [...current, draftAgent(id, access, current.filter(isMine).map((agent) => agent.color))]);
    markThreadRead();
    setDesktopView({ kind: "agent", agentId: id, panel: null, thread: null });
  };

  // Saying the job again replaces it. A short message that only says when changes how often.
  const giveJobTo = (agentId: string, text: string) => {
    setAgents((current) => current.map((agent) => (agent.id === agentId
      ? giveJob(agent, text, current.filter((entry) => entry.id !== agentId && isMine(entry)).map((entry) => entry.name))
      : agent)));
  };

  const askOften = (agentId: string, asking: "start" | "often") => {
    setAgents((current) => current.map((agent) => (agent.id === agentId && agent.setup ? { ...agent, setup: { ...agent.setup, asking } } : agent)));
  };

  // Starting it turns it on and does a first check at once, so the first result is one answer away.
  const startAgentFor = (agentId: string, schedule?: Schedule) => {
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent?.setup) return;
    const started = startAgent(agent, access, schedule);
    setAgents((current) => current.map((entry) => (entry.id === agentId ? started : entry)));
    begin(agentId, "routine", { routineId: started.routines[0]?.id, as: started });
  };

  // A manager is always someone the agent is shared with.
  const shareAgent = (id: string, share: AccessDraft, managers: string[]) => patchAgent(id, { share, managers: keepManagers(managers, share) });

  // Your own agent keeps what you tell it at once. A shared agent asks first, because it changes for everyone who uses it.
  const addNote = (agentId: string, text: string) => {
    const noteId = nextId("note");
    setAgents((current) => current.map((agent) => {
      if (agent.id !== agentId) return agent;
      const forEveryone = noteAsksFirst(agent);
      return { ...agent, notes: [...agent.notes, { id: noteId, text, afterRuns: agent.runs.length, by: ME, forEveryone, state: forEveryone ? "ask" : "kept" }] };
    }));
  };

  const answerNote = (agentId: string, noteId: string, keep: boolean) => {
    setAgents((current) => current.map((agent) => (agent.id === agentId
      ? { ...agent, notes: agent.notes.map((note) => (note.id === noteId && note.state === "ask" ? { ...note, state: keep ? "kept" : "dropped" } : note)) }
      : agent)));
  };

  const removeNote = (agentId: string, noteId: string) => {
    setAgents((current) => current.map((agent) => (agent.id === agentId ? { ...agent, notes: agent.notes.filter((note) => note.id !== noteId) } : agent)));
  };

  const askChat = (prompt: string) => {
    const result = interpretChat({ prompt, agents, access, connected, id: nextId("chat"), when: clockNow(), contextId, pendingName: pendingProposalName(turns) });
    const turnId = nextId("turn");
    setAgents(result.agents);
    setContextId(result.agentId);
    setTurns((current) => [...current, { id: turnId, prompt, reply: result.reply, card: result.card, steps: result.steps.map((step, index) => ({ ...step, key: `${turnId}-${index}` })) }]);
  };

  // Anything that gives an agent more reach waits here for a click.
  const resolveCard = (turnId: string, accept: boolean) => {
    const card = turns.find((turn) => turn.id === turnId)?.card;
    if (!card) return;
    const setCard = (next: ChatCard) => setTurns((current) => current.map((turn) => (turn.id === turnId ? { ...turn, card: next } : turn)));
    if (card.kind === "proposal" && card.state === "draft") {
      if (!accept) {
        setCard({ ...card, state: "dismissed" });
        return;
      }
      const id = nextId("agent");
      setAgents((current) => [...current, agentFromDraft(card.draft, id, access)]);
      setContextId(id);
      setCard({ ...card, state: "on", agentId: id });
      return;
    }
    if (card.kind === "permission" && card.state === "ask") {
      if (accept) {
        const every = toolsForLevel(connectorById(card.connector), "write");
        setAgents((current) => current.map((agent) => (agent.id === card.agentId
          ? {
            ...agent,
            tools: { ...agent.tools, [card.connector]: every.filter((tool) => agent.tools[card.connector].includes(tool) || card.tools.includes(tool)) },
            instructions: card.addInstructions ? `${agent.instructions} ${card.addInstructions}` : agent.instructions,
          }
          : agent)));
      }
      setCard({ ...card, state: accept ? "allowed" : "kept" });
      return;
    }
    if (card.kind === "share" && card.state === "ask") {
      if (accept) shareAgent(card.agentId, card.share, card.managers);
      setCard({ ...card, state: accept ? "shared" : "kept" });
    }
  };

  const changeScenario = (next: Scenario) => {
    const fresh = next === "empty" ? [] : sampleAgents();
    setScenario(next);
    setAgents(fresh);
    setSeenRuns(startingSeen(fresh));
    setSessions(seedSessions(fresh));
    setRemoved(null);
    setTurns([]);
    setContextId(null);
    setDesktopView({ kind: "chat" });
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <div
        className="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-slate-800 bg-[#0f172a] px-4 py-2 text-[12px] text-slate-300"
        data-testid="prototype-bar"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 font-medium text-white">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Prototype · Personal agents · sample data
          </span>
          <DenSegmented
            aria-label="Who is looking"
            value={viewer}
            onChange={changeViewer}
            options={[
              { value: "member", label: "Member · OpenWork app" },
              { value: "admin", label: "Admin · Cloud dashboard" },
            ]}
            optionTestId={(value) => `proto-role-${value}`}
          />
          <DenSegmented
            aria-label="Starting point"
            value={scenario}
            onChange={changeScenario}
            options={[
              { value: "sample", label: "With sample agents" },
              { value: "empty", label: "First visit" },
            ]}
            optionTestId={(value) => `proto-scenario-${value}`}
          />
        </div>
        <p className="text-slate-400" data-testid="proto-role-note">{VIEWER_NOTE[viewer]}</p>
      </div>

      {viewer === "admin" ? (
        <AdminDashboard tab={adminTab} onTab={setAdminTab} agents={agents} access={access} onAccess={setAccess} onPatchAgent={patchAgent} />
      ) : (
        <DesktopApp
          view={desktopView}
          onView={changeDesktopView}
          agents={agents}
          access={access}
          connected={connected}
          turns={turns}
          unreadIds={unreadIds}
          sessions={sessions}
          nowMs={nowMs}
          onAsk={askChat}
          onCard={resolveCard}
          onSend={sendTo}
          onRun={runAgent}
          onStop={stopSession}
          onAnswerAsk={answerAsk}
          onAnswerNote={answerNote}
          onReply={replyInThread}
          onMoveReply={moveReply}
          onPatch={patchAgent}
          removed={removed}
          onRemove={removeAgent}
          onUndoRemove={undoRemove}
          onCopy={makeCopy}
          onShare={shareAgent}
          onRemoveNote={removeNote}
          onConnect={(id) => setConnected((current) => ({ ...current, [id]: true }))}
          onCreate={createAgent}
          onJob={giveJobTo}
          onAskOften={askOften}
          onStart={startAgentFor}
        />
      )}
    </div>
  );
}
