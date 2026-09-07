"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, MessageCircle, ListTodo, Plug, RotateCcw, ArrowUp, ArrowRight, ChevronLeft, Check, Pause, Play, Plus, Users } from "lucide-react";
import { CoworkerAvatar, CoworkerMark, acknowledgeCoworker } from "./coworker-brand";
import { CoworkerAction } from "./coworker-announcement-actions";
import { DEMO_VIEWS, EXAMPLES, TEAM, DEFAULT_DEMO_COWORKER, customExample, type CoworkerId, type DemoView, type DemoCoworker, type StockCoworkerId } from "../lib/coworker-demo";
import { CoworkerDemoBuilder } from "./coworker-demo-builder";
import { CoworkerDemoEffort } from "./coworker-demo-effort";
import { CoworkerDemoModels } from "./coworker-demo-models";
import { DemoQuestionCard, GroupComposer, GroupConversation, GroupFaces, Thinking } from "./coworker-demo-conversations";
import { capturePosthogEvent } from "../lib/posthog-client";

const VIEW_ICONS = { chat: MessageCircle, documents: FileText, assignments: ListTodo, connections: Plug, group: Users, create: Plus };
type Model = "free" | "models";
type Progress = { replied: boolean; thinking: boolean; answer: number | null; answerThinking: boolean; assigned: boolean; resultOpen: boolean; routinePaused: boolean; model: Model; effort: number };
type DemoAction = "coworker_selected" | "view_opened" | "message_sent" | "document_opened" | "assignment_created" | "assignment_result_opened" | "schedule_toggled" | "connection_toggled" | "model_selected" | "reset" | "group_started" | "group_recipient_selected" | "coworker_created" | "question_answered";
function emptyProgress(): Progress { return { replied: false, thinking: false, answer: null, answerThinking: false, assigned: false, resultOpen: false, routinePaused: false, model: "free", effort: 2 }; }
function freshProgress(): Record<CoworkerId, Progress> {
  return { scout: emptyProgress(), editor: emptyProgress(), ops: emptyProgress() };
}

/** An interactive sample workspace. All state is local to this component;
 * it never calls inference, auth, connection, document, or scheduling APIs. */
export function CoworkerVignette() {
  const [selected, setSelected] = useState<CoworkerId>("scout");
  const [view, setView] = useState<DemoView>("chat");
  const [progress, setProgress] = useState(freshProgress);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [connections, setConnections] = useState({ drive: false, slack: false });
  const [completed, setCompleted] = useState<Set<DemoView>>(() => new Set());
  const [status, setStatus] = useState("");
  const [motion, setMotion] = useState(true);
  const [groupStep, setGroupStep] = useState(0);
  const [groupEffort, setGroupEffort] = useState(2);
  const [groupSelected, setGroupSelected] = useState<StockCoworkerId[]>(() => TEAM.map((person) => person.id));
  const [groupRun, setGroupRun] = useState<StockCoworkerId[]>([]);
  const [draft, setDraft] = useState<DemoCoworker>(DEFAULT_DEMO_COWORKER);
  const [custom, setCustom] = useState<Array<DemoCoworker & { id: CoworkerId }>>([]);
  const customId = useRef(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const completedRef = useRef(new Set<DemoView>());
  useEffect(() => { const pending = timers.current; return () => { pending.forEach(clearTimeout); pending.clear(); }; }, []);
  const started = useRef(false);
  const completionSent = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const demoRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const team = [...TEAM, ...custom];
  const member = team.find((person) => person.id === selected)!;
  const state = progress[selected];
  const customMember = custom.find((person) => person.id === selected);
  const example = selected === "scout" || selected === "editor" || selected === "ops" ? EXAMPLES[selected] : customExample(customMember!, state.answer);
  const groupBusy = groupStep > 0 && groupStep <= groupRun.length;
  const groupDone = groupStep > groupRun.length;
  const groupSpeaker = groupBusy ? TEAM.filter((person) => groupRun.includes(person.id))[groupStep - 1]?.id : undefined;

  useEffect(() => {
    if (started.current) {
      titleRef.current?.focus({ preventScroll: true });
      demoRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [selected, view, documentOpen]);
  useEffect(() => {
    if (((view === "chat" && (state.replied || state.thinking)) || (view === "group" && groupStep > 0)) && contentRef.current) {
      contentRef.current.scrollTo({ top: contentRef.current.scrollHeight, behavior: "auto" });
    }
  }, [selected, view, state.replied, state.thinking, state.answer, state.answerThinking, groupStep]);

  function track(action: DemoAction, detail?: string) {
    if (!started.current) {
      started.current = true;
      capturePosthogEvent("coworker_demo_started", { campaign: "coworker", version: 1 });
    }
    // Only fixed example identifiers reach analytics; no visitor input or account data.
    capturePosthogEvent("coworker_demo_interacted", { campaign: "coworker", action, coworker: selected.startsWith("custom-") ? "custom" : selected, view, detail: detail?.startsWith("custom-") ? "custom" : detail });
  }
  function markComplete(part: DemoView) {
    const next = new Set(completedRef.current).add(part);
    completedRef.current = next;
    setCompleted(next);
    if (next.size === 6 && !completionSent.current) {
      completionSent.current = true;
      capturePosthogEvent("coworker_demo_completed", { campaign: "coworker", version: 1 });
    }
  }
  function update(change: Partial<Progress>) {
    setProgress((current) => ({ ...current, [selected]: { ...current[selected], ...change } }));
  }
  function openView(next: DemoView) {
    track("view_opened", next);
    setView(next);
    setDocumentOpen(false);
  }
  function chooseCoworker(id: CoworkerId) {
    track("coworker_selected", id);
    if (motion) acknowledgeCoworker("landing:" + id);
    setSelected(id);
    setView("chat");
    setDocumentOpen(false);
  }
  function later(key: string, delay: number, callback: () => void) {
    clearTimeout(timers.current.get(key));
    const timer = setTimeout(() => { timers.current.delete(key); callback(); }, !motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 30 : delay);
    timers.current.set(key, timer);
  }
  function playGroup() {
    if (groupBusy || !groupSelected.length) return;
    track("group_started");
    if (motion) groupSelected.forEach((id) => acknowledgeCoworker("landing:" + id));
    setGroupRun([...groupSelected]);
    setGroupStep(1);
    function next(step: number) {
      later("group", 1200, () => {
        setGroupStep(step);
        if (step <= groupSelected.length) next(step + 1);
        else { markComplete("group"); setStatus("The selected coworkers have replied in the sample group chat."); }
      });
    }
    next(2);
  }
  function createCoworker() {
    if (!draft.name.trim() || !draft.role.trim() || !draft.mission.trim() || draft.responsibilities.some((item) => !item.trim())) return;
    const id: CoworkerId = `custom-${++customId.current}`;
    const next = { ...draft, id, name: draft.name.trim(), role: draft.role.trim(), mission: draft.mission.trim(), responsibilities: draft.responsibilities.map((item) => item.trim()) };
    track("coworker_created");
    if (motion) acknowledgeCoworker("landing:" + id, "wake");
    setCustom((current) => [...current, next]);
    setDraft(DEFAULT_DEMO_COWORKER);
    setProgress((current) => ({ ...current, [id]: emptyProgress() }));
    setSelected(id); setView("chat"); setDocumentOpen(false);
    markComplete("create"); setStatus(next.name + " joined the sample workspace.");
  }
  function answerQuestion(index: number) {
    if (state.answerThinking || state.answer === index || !example.clarification.options[index]) return;
    track("question_answered", String(index));
    if (motion) acknowledgeCoworker("landing:" + selected);
    update({ answer: index, answerThinking: true, assigned: false, resultOpen: false });
    later("answer:" + selected, 1000, () => {
      setProgress((current) => ({ ...current, [selected]: { ...current[selected], answerThinking: false } }));
      setStatus(member.name + " used your answer to shape the next step.");
    });
  }
  function reply() {
    if (state.replied || state.thinking) return;
    track("message_sent");
    if (motion) acknowledgeCoworker("landing:" + selected);
    update({ thinking: true });
    later("reply:" + selected, 1300, () => {
      setProgress((current) => ({ ...current, [selected]: { ...current[selected], replied: true, thinking: false } }));
      markComplete("chat");
      setStatus(member.name + " replied to the example message.");
    });
  }
  function openDocument() {
    track("document_opened");
    setView("documents");
    setDocumentOpen(true);
    markComplete("documents");
  }
  function assign() {
    track("assignment_created");
    update({ assigned: true });
    markComplete("assignments");
    setStatus("Example assignment added for " + member.name + ".");
  }
  function toggleConnection(id: "drive" | "slack") {
    track("connection_toggled", id);
    setConnections((current) => ({ ...current, [id]: !current[id] }));
    if (!connections[id]) markComplete("connections");
    setStatus((id === "drive" ? "Google Drive" : "Slack") + (connections[id] ? " disconnected in the demo." : " connected in the demo."));
  }
  function reset() {
    track("reset");
    timers.current.forEach(clearTimeout); timers.current.clear();
    setGroupStep(0); setGroupEffort(2); setGroupRun([]); setGroupSelected(TEAM.map((person) => person.id)); setCustom([]); setDraft(DEFAULT_DEMO_COWORKER); customId.current = 0;
    completedRef.current.clear();
    setProgress(freshProgress());
    setSelected("scout");
    setView("chat");
    setDocumentOpen(false);
    setConnections({ drive: false, slack: false });
    setCompleted(new Set());
    setStatus("The sample workspace has been reset.");
  }

  const panelTitle = view === "group" ? "Launch team" : view === "create" ? "Add a coworker" : view === "chat" ? "With " + member.name : view === "documents" && documentOpen ? example.document.title : view === "connections" ? "Connect your tools" : member.name + "’s " + view;

  return (
    <div className="cw-demo ph-no-capture" ref={demoRef} data-testid="coworker-demo" data-motion={motion ? "on" : "off"}>
      <div className="cw-demo-scenarios" aria-label="Choose a walkthrough">
        <button type="button" aria-pressed={view === "chat"} onClick={() => openView("chat")}><MessageCircle size={15} aria-hidden="true" />Check in</button>
        <button type="button" aria-pressed={view === "group"} onClick={() => openView("group")} id="demo-open-group" data-testid="demo-open-group"><Users size={15} aria-hidden="true" />Work as a team</button>
        <button type="button" aria-pressed={view === "create"} onClick={() => openView("create")} id="demo-open-create" data-testid="demo-open-create" aria-label="Explore adding a coworker"><Plus size={15} aria-hidden="true" />Add a coworker</button>
      </div>
      <div className="cw-demo-topbar">
        <div className="flex items-center gap-2.5"><CoworkerMark size={23} /><span className="text-xs font-medium">Open Coworker</span></div>
        <div className="flex items-center gap-3"><span className="cw-demo-badge">Interactive demo</span><button type="button" className="cw-demo-icon-button" aria-label={motion ? "Pause animation" : "Resume animation"} onClick={() => setMotion(!motion)}>{motion ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}</button><button type="button" className="cw-demo-icon-button" aria-label="Reset demo" onClick={reset}><RotateCcw size={15} aria-hidden="true" /></button></div>
      </div>
      <div className="cw-demo-layout">
        <aside className="cw-demo-sidebar" aria-label="Demo workspace">
          <p className="cw-eyebrow cw-demo-sidebar-label">Your coworkers</p>
          <div className="cw-demo-team" role="group" aria-label="Choose a demo coworker">
            {team.map((person) => <button type="button" key={person.id} aria-label={"Talk to " + person.name} aria-pressed={selected === person.id && view !== "group" && view !== "create"} className="cw-demo-person" onClick={() => chooseCoworker(person.id)}>
              <CoworkerAvatar {...person} identity={"landing:" + person.id} animated={motion} motion="navigation" size={30} /><span><span className="block text-sm font-medium">{person.name}</span><span className="cw-demo-role">{person.role}</span></span>
            </button>)}
          </div>
          <button type="button" className="cw-demo-add" onClick={() => openView("create")}><Plus size={15} aria-hidden="true" />Add a coworker</button>
          <button type="button" className="cw-demo-group-link" aria-pressed={view === "group"} onClick={() => openView("group")}><GroupFaces active={groupSpeaker} animated={motion} /><span>Launch team<small>Group chat</small></span></button>
          <nav className="cw-demo-nav" aria-label="Explore the demo">
            {DEMO_VIEWS.map((item) => {
              const Icon = VIEW_ICONS[item.id];
              return <button type="button" key={item.id} aria-pressed={view === item.id} aria-controls="coworker-demo-panel" className="cw-demo-nav-item" onClick={() => openView(item.id)} data-testid={"demo-view-" + item.id}><Icon size={16} aria-hidden="true" /><span>{item.label}</span></button>;
            })}
          </nav>
          <p className="cw-demo-sidebar-note">A little company for the work ahead.</p>
        </aside>
        <section className="cw-demo-workspace" id="coworker-demo-panel" aria-labelledby="coworker-demo-title">
          <header className="cw-demo-panel-header">
            <h3 id="coworker-demo-title" ref={titleRef} tabIndex={-1}>{panelTitle}</h3>
            <span className="text-[11px] text-[var(--cw-muted)]">Sample workspace</span>
          </header>
          <div className="cw-demo-content" ref={contentRef} tabIndex={0} role="region" aria-label={member.name + " " + view + " example"} key={selected + view + documentOpen}>
            {view === "create" && <CoworkerDemoBuilder value={draft} identity={"landing:custom-" + (customId.current + 1)} animated={motion} onChange={setDraft} onCreate={createCoworker} />}
            {view === "group" && <GroupConversation step={groupStep} run={groupRun} active={groupSpeaker} animated={motion} />}
            {view === "chat" && <div className="cw-demo-conversation">
              <div className="flex justify-end"><p className="cw-chat-request">{example.question}</p></div>
              <div className="cw-demo-reply"><CoworkerAvatar {...member} identity={"landing:" + member.id} animated={false} motion="quiet" gaze={false} size={27} /><div className="min-w-0"><p className="cw-demo-speaker">{member.name}</p><p>{example.answer}</p>
                {customMember && <div className="cw-demo-owned-work"><p>What I’ll help with</p><ul>{example.responsibilities.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                <button type="button" className="cw-chat-document" onClick={openDocument} aria-label={"Open " + example.document.title}><FileText size={20} aria-hidden="true" /><span className="flex-1"><span className="block text-sm font-medium text-[var(--cw-text)]">{example.document.title}</span><span className="mt-0.5 block text-xs text-[var(--cw-muted)]">Draft · Ready to review</span></span><ArrowRight size={15} aria-hidden="true" /></button>
              </div></div>
              {(state.replied || state.thinking) && <div className="cw-demo-message-enter" data-testid="demo-follow-up"><div className="mb-6 flex justify-end"><p className="cw-chat-request">{example.followUp}</p></div>{state.thinking ? <Thinking member={member} /> : <div className="cw-demo-reply cw-demo-message-enter"><CoworkerAvatar {...member} identity={"landing:" + member.id} animated={false} motion="quiet" gaze={false} size={27} /><div><p className="cw-demo-speaker">{member.name}</p><p>{example.reply}</p></div></div>}</div>}
              {state.replied && <DemoQuestionCard member={member} question={example.clarification} selected={state.answer} thinking={state.answerThinking} onChoose={answerQuestion} />}
            </div>}
            {view === "documents" && (documentOpen ? <article className="cw-demo-document" data-testid="demo-document-preview">
              <button type="button" className="cw-demo-text-button mb-7" onClick={() => setDocumentOpen(false)}><ChevronLeft size={14} aria-hidden="true" />All documents</button>
              <p className="cw-eyebrow">{example.document.eyebrow}</p><h4>{example.document.title}</h4><p>{example.document.intro}</p>
              {selected === "editor" && state.replied && <div className="cw-demo-note"><strong>Alternative opening</strong><p>Good work starts with a little company. Meet your new coworkers.</p></div>}
              {state.answer !== null && !state.answerThinking && <div className="cw-demo-note"><strong>Your direction · {example.clarification.options[state.answer]!.label}</strong><p>{example.clarification.options[state.answer]!.reply}</p></div>}
              <h5>What matters</h5><ul>{example.document.points.map((point) => <li key={point}>{point}</li>)}</ul><h5>Next step</h5><p>{example.document.next}</p>
            </article> : <div className="cw-demo-panel-body"><p className="cw-demo-description">The work you can open, review, and build on.</p><button type="button" className="cw-demo-list-row" onClick={openDocument} aria-label={"Read " + example.document.title}><FileText size={23} aria-hidden="true" /><span className="flex-1"><strong>{example.document.title}</strong><small>{member.name} · Ready to review</small></span><ArrowRight size={16} aria-hidden="true" /></button></div>)}
            {view === "assignments" && <div className="cw-demo-panel-body">
              <p className="cw-demo-description">Give {member.name} an outcome to work toward.</p>
              <div className="cw-demo-owned-work"><p>{member.name}’s responsibilities</p><ul>{example.responsibilities.map((item, index) => <li key={index}>{item}</li>)}</ul></div>
              <p className="cw-eyebrow mb-3">Once</p>
              <div className="cw-demo-task" data-testid="demo-assignment">
                <h4>{example.assignment.title}</h4><p>{example.assignment.description}</p>
                {!state.assigned ? <button type="button" className="cw-demo-small-button mt-4" onClick={assign}>{"Assign to " + member.name}<ArrowRight size={14} aria-hidden="true" /></button> : <>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><span className="cw-demo-status"><span aria-hidden="true">●</span>{state.resultOpen ? "Ready to review" : "Working on it · Demo"}</span>{!state.resultOpen && <button type="button" className="cw-demo-text-button" onClick={() => { track("assignment_result_opened"); update({ resultOpen: true }); }}>See sample result<ArrowRight size={14} aria-hidden="true" /></button>}</div>
                  {state.resultOpen && <div className="cw-demo-note" role="status">{example.assignment.result}</div>}
                </>}
              </div>
              <p className="cw-eyebrow mb-3 mt-8">On a schedule</p>
              <div className="cw-demo-list-row"><span className="flex-1"><strong>{example.routine}</strong><small>{state.routinePaused ? "Paused in demo" : (selected === "ops" ? "Fridays" : "Mondays") + " at 9:00 AM · Active"}</small></span><button type="button" className="cw-demo-icon-button" aria-label={state.routinePaused ? "Resume sample schedule" : "Pause sample schedule"} onClick={() => { track("schedule_toggled"); update({ routinePaused: !state.routinePaused }); setStatus(state.routinePaused ? "Sample schedule resumed." : "Sample schedule paused."); }}>{state.routinePaused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}</button></div>
              <p className="mt-4 text-xs leading-5 text-[var(--cw-muted)]">In the app, local schedules run while Coworker is open. Nothing is scheduled by this demo.</p>
            </div>}
            {view === "connections" && <div className="cw-demo-panel-body">
              <p className="cw-eyebrow mb-4">OpenWork Connect</p><h4 className="text-2xl font-medium tracking-tight">Bring your work into the conversation.</h4><p className="cw-demo-description mt-3">Let your coworkers use the tools you already work with. Try a sample connection below.</p>
              <div className="space-y-3">
                <div className="cw-demo-list-row"><span className="cw-demo-provider" aria-hidden="true">D</span><span className="flex-1"><strong>Google Drive</strong><small>{connections.drive ? "Connected in demo · 3 sample documents" : "Docs and working files"}</small></span><button type="button" className="cw-demo-small-button" onClick={() => toggleConnection("drive")} aria-label={connections.drive ? "Disconnect Google Drive demo" : "Connect Google Drive demo"}>{connections.drive ? <><Check size={14} aria-hidden="true" />Connected</> : "Connect"}</button></div>
                <div className="cw-demo-list-row"><span className="cw-demo-provider" aria-hidden="true">S</span><span className="flex-1"><strong>Slack</strong><small>{connections.slack ? "Connected in demo · #launch-team" : "Team updates and conversations"}</small></span><button type="button" className="cw-demo-small-button" onClick={() => toggleConnection("slack")} aria-label={connections.slack ? "Disconnect Slack demo" : "Connect Slack demo"}>{connections.slack ? <><Check size={14} aria-hidden="true" />Connected</> : "Connect"}</button></div>
              </div>
              {(connections.drive || connections.slack) && <div className="cw-demo-note"><strong>Ready for your next conversation</strong><p>{connections.drive ? "The sample launch brief, checklist, and announcement are available to your demo coworkers. " : ""}{connections.slack ? "The sample launch-team updates are available too." : ""}</p></div>}
              <p className="mt-5 text-xs leading-5 text-[var(--cw-muted)]">These are example connections. Your accounts and files stay untouched.</p>
            </div>}
          </div>
          {view === "group" && <GroupComposer effort={groupEffort} onEffortChange={setGroupEffort} selected={groupSelected} busy={groupBusy} animated={motion} onSend={playGroup} onEveryone={() => { track("group_recipient_selected", "everyone"); if (motion) TEAM.filter((person) => !groupSelected.includes(person.id)).forEach((person) => acknowledgeCoworker("landing:" + person.id)); setGroupSelected(TEAM.map((person) => person.id)); }} onToggle={(id) => { track("group_recipient_selected", id); if (motion && !groupSelected.includes(id)) acknowledgeCoworker("landing:" + id); setGroupSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]); }} />}
          {view === "chat" && <div className="cw-demo-composer-area">
            {state.model === "models" && <div className="cw-demo-model-note">Explore models through an OpenWork membership.<CoworkerAction href="#models" action="models" placement="demo" className="underline underline-offset-4">See membership<ArrowRight size={12} aria-hidden="true" /></CoworkerAction></div>}
            <form className="cw-demo-composer" onSubmit={(event) => { event.preventDefault(); reply(); }}>
              <label className="sr-only" htmlFor="coworker-example-message">Example message</label><textarea id="coworker-example-message" rows={2} readOnly value={state.replied ? "Open the draft or try another coworker" : example.followUp} aria-describedby="coworker-demo-disclosure" />
              <div className="cw-demo-composer-actions"><div className="cw-demo-model-label"><CoworkerDemoModels key={selected} value={state.model} onChange={(model) => { track("model_selected", model); update({ model }); setStatus("Model source changed in the sample workspace."); }} /></div><CoworkerDemoEffort key={selected} value={state.effort} onChange={(effort) => update({ effort })} /><button type="submit" className="cw-demo-send" aria-label="Send example message" disabled={state.replied || state.thinking}><ArrowUp size={17} aria-hidden="true" /></button></div>
            </form>
          </div>}
        </section>
      </div>
      <div className="cw-demo-guide">
        <div><p className="font-medium">{completed.size === 6 ? "Make a little room on your team." : view === "group" ? "Different strengths. One conversation." : view === "create" ? "A coworker shaped around your work." : view === "chat" ? state.replied ? "There’s something to build on." : "Try the conversation." : view === "documents" ? "A draft you can make your own." : view === "assignments" ? "Give your coworker the next step." : "A place for your tools, too."}</p>
          <p className="mt-1 text-xs text-[var(--cw-muted)]">{completed.size === 6 ? "You’ve explored a sample workday. Meet your own coworkers next." : "Explore at your own pace · " + completed.size + " of 6 moments tried"}</p></div>
        {completed.size === 6 ? <CoworkerAction href="#get-started" action="early_access" placement="demo" className="cw-demo-small-button">Get early access<ArrowRight size={14} aria-hidden="true" /></CoworkerAction>
          : view === "group" ? <button type="button" className="cw-demo-small-button" disabled={groupBusy || (!groupDone && groupSelected.length === 0)} onClick={groupDone ? () => openView("create") : playGroup}>{groupDone ? "Add your coworker" : groupBusy ? "Coworkers are replying…" : "Try a group chat"}<ArrowRight size={14} aria-hidden="true" /></button>
          : view === "create" ? <span className="text-xs text-[var(--cw-muted)]">Your changes appear in the preview.</span>
          : view === "chat" ? <button type="button" className="cw-demo-small-button" disabled={state.thinking} onClick={state.replied ? openDocument : reply}>{state.thinking ? "Thinking…" : state.replied ? "Open the draft" : "Try a reply"}<ArrowRight size={14} aria-hidden="true" /></button>
          : view === "documents" ? <button type="button" className="cw-demo-small-button" onClick={documentOpen ? () => openView("assignments") : openDocument}>{documentOpen ? "Explore assignments" : "Open the draft"}<ArrowRight size={14} aria-hidden="true" /></button>
          : view === "assignments" ? <button type="button" className="cw-demo-small-button" onClick={state.assigned ? () => openView("connections") : assign}>{state.assigned ? "Explore connections" : "Try an assignment"}<ArrowRight size={14} aria-hidden="true" /></button>
          : <button type="button" className="cw-demo-small-button" onClick={() => connections.drive || connections.slack ? openView("group") : toggleConnection("drive")}>{connections.drive || connections.slack ? "Try a group chat" : "Try a connection"}<ArrowRight size={14} aria-hidden="true" /></button>}
      </div>
      <p className="sr-only" role="status">{status}</p>
    </div>
  );
}

/** A page invitation opens the same walkthrough view as its own navigation. */
export function CoworkerDemoShortcut({ view, children }: { view: "group" | "create"; children: ReactNode }) {
  return <a href="#how" className="mt-5 inline-flex items-center gap-2 text-sm underline underline-offset-4" onClick={() => document.getElementById("demo-open-" + view)?.click()}>{children}<ArrowRight size={14} aria-hidden="true" /></a>;
}
