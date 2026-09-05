"use client";

import { ArrowUp, Check, Users } from "lucide-react";
import { OptionRow } from "@openwork/ui/coworker-option";
import { CoworkerDemoEffort } from "./coworker-demo-effort";
import { CoworkerAvatar } from "./coworker-brand";
import { TEAM, type DemoCoworker, type DemoQuestion, type StockCoworkerId } from "../lib/coworker-demo";

type Member = Pick<DemoCoworker, "name" | "color" | "glasses">;

export function Thinking({ member }: { member: Member }) {
  return <div className="cw-demo-thinking" role="status" data-testid="demo-thinking"><CoworkerAvatar {...member} size={27} working /><span className="cw-demo-typing" aria-hidden="true">{[0, 1, 2].map((index) => <i key={index} style={{ animationDelay: `${index * 160}ms` }} />)}</span><span>{member.name} is thinking…</span></div>;
}

/** Uses the actual app's lettered answer row. Only the displayed sample reply
 * changes; clicking never answers a live pending question. */
export function DemoQuestionCard({ member, question, selected, thinking, onChoose }: {
  member: Member; question: DemoQuestion; selected: number | null; thinking: boolean; onChoose: (index: number) => void;
}) {
  return <div className="cw-demo-question cw-demo-message-enter" data-testid="demo-question">
    <p className="cw-demo-speaker">{member.name} has a question</p><h4>{question.prompt}</h4>
    <div className="cw-demo-question-options" role="listbox" aria-label={question.prompt} tabIndex={0} onKeyDown={(event) => {
      if (thinking || event.altKey || event.metaKey || event.ctrlKey) return;
      const index = "ABC".indexOf(event.key.toUpperCase());
      if (index >= 0 && index < question.options.length) { event.preventDefault(); onChoose(index); }
    }}>
      {question.options.map((option, index) => <OptionRow key={index} letter={"ABC"[index]!} label={option.label} description={option.description} active={selected === index} disabled={thinking} onChoose={() => onChoose(index)} testId={"demo-answer-" + index} />)}
    </div>
    {selected === null ? <p className="cw-demo-question-hint">Choose an answer to shape the next step.</p> : thinking ? <Thinking member={member} /> : <p className="cw-demo-answer cw-demo-message-enter" role="status" data-testid="demo-answer-result">{question.options[selected]!.reply}</p>}
  </div>;
}

export function GroupFaces() {
  return <span className="cw-demo-group-faces" aria-hidden="true">{TEAM.map((person) => <CoworkerAvatar key={person.id} {...person} size={25} />)}</span>;
}

const GROUP_REPLIES: Record<StockCoworkerId, string> = {
  scout: "The clearest angle is time back for the work you care about. Lead with a useful first draft, then show how people can shape it with their coworker.",
  editor: "I’d open with: ‘Your work. Better together.’ Then show a quick check-in turning into a draft you can use.",
  ops: "I’ll turn that into a simple handoff: finish the draft, review the walkthrough, then invite the first users. You choose when we’re ready to share.",
};

function mentionLine(ids: StockCoworkerId[]) {
  return ids.length === TEAM.length ? "@everyone" : TEAM.filter((person) => ids.includes(person.id)).map((person) => "@" + person.name).join(" ");
}

export function GroupConversation({ step, run }: { step: number; run: StockCoworkerId[] }) {
  const responders = TEAM.filter((person) => run.includes(person.id));
  return <div className="cw-demo-conversation cw-demo-group-conversation">
    <div className="cw-demo-group-intro"><GroupFaces /><div><h4>You, Scout, Editor & Ops.</h4><p>Research, writing, and a plan. Choose one coworker’s perspective, or bring everyone in.</p></div></div>
    {step === 0 ? <div className="cw-demo-group-start"><Users size={25} aria-hidden="true" /><p>Who would you like to hear from?<br />Choose below, then send the example message.</p></div> : <>
      <div className="flex justify-end"><p className="cw-chat-request">{mentionLine(run)} — help me get this launch ready. What should we do next?</p></div>
      {responders.map((person, index) => step > index + 1 ? <div className="cw-demo-reply cw-demo-message-enter" key={person.id} data-testid={"demo-group-reply-" + person.id}><CoworkerAvatar {...person} size={27} /><div><p className="cw-demo-speaker">{person.name}<span>{person.role}</span></p><p>{person.id === "editor" && run.includes("scout") ? "Building on Scout’s research, " + GROUP_REPLIES.editor : GROUP_REPLIES[person.id]}</p></div></div> : step === index + 1 ? <Thinking key={person.id} member={person} /> : null)}
      {step > responders.length && <div className="cw-demo-group-end cw-demo-message-enter" role="status"><span><Check size={14} aria-hidden="true" />{responders.length === TEAM.length ? "A direction, a draft, and a plan." : responders.map((person) => person.name).join(" and ") + " replied. The others stayed out of this turn."}</span></div>}
    </>}
  </div>;
}

export function GroupComposer({ selected, busy, onToggle, onEveryone, onSend, effort, onEffortChange }: {
  effort: number; onEffortChange: (effort: number) => void;
  selected: StockCoworkerId[]; busy: boolean; onToggle: (id: StockCoworkerId) => void; onEveryone: () => void; onSend: () => void;
}) {
  return <div className="cw-demo-group-composer">
    <div className="cw-demo-recipient-label"><span>Who should reply?</span><span>Use @ in the app</span></div>
    <div className="cw-demo-recipients" role="group" aria-label="Choose who replies">
      {TEAM.map((person) => <button type="button" key={person.id} disabled={busy} aria-pressed={selected.includes(person.id)} aria-label={"Ask " + person.name + " to reply"} onClick={() => onToggle(person.id)}><CoworkerAvatar {...person} size={18} /><span>{person.name}</span>{selected.includes(person.id) && <Check size={11} aria-hidden="true" />}</button>)}
      <button type="button" disabled={busy} aria-pressed={selected.length === TEAM.length} onClick={onEveryone}>Everyone</button>
    </div>
    <form className="cw-demo-group-message" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      <p><span data-testid="demo-group-mentions">{mentionLine(selected)}</span>{selected.length ? " — help me get this launch ready." : "Choose at least one coworker."}</p>
      <div className="cw-demo-composer-actions"><CoworkerDemoEffort value={effort} onChange={onEffortChange} /><button type="submit" className="cw-demo-send" aria-label="Send group message" disabled={busy || selected.length === 0}><ArrowUp size={17} aria-hidden="true" /></button></div>
    </form>
  </div>;
}
