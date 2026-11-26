"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Composer, QuestionCard, UserBubble } from "./app-parts";
import { AgentSays, WorkingLine } from "./conversation";
import { type Agent, type AgentSetup, type Schedule, JOB_EXAMPLES, OFTEN_CHOICES, planLine } from "./model";

// ---------------------------------------------------------------------------
// Starting from +: a new agent is a chat, not a form. You say what it should
// do, it says back what it will do and how often, and one answer starts it.
// Tools are asked for when it first needs them; the budget is your own limit.
// ---------------------------------------------------------------------------

export function NewAgentChat({ agent, setup, header, onJob, onAskOften, onStart }: {
  agent: Agent;
  setup: AgentSetup;
  header: ReactNode;
  onJob: (text: string) => void;
  onAskOften: (asking: AgentSetup["asking"]) => void;
  onStart: (schedule?: Schedule) => void;
}) {
  const [text, setText] = useState("");
  const [focusKey, setFocusKey] = useState(0);
  const hasJob = agent.said.length > 0;
  const plan = planLine(agent, setup.schedule);
  // It takes a moment to read the job, the way a person would.
  const [readFor, setReadFor] = useState<string | null>(null);
  const reading = hasJob && readFor !== plan;
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasJob) return;
    const timer = window.setTimeout(() => setReadFor(plan), 900);
    return () => window.clearTimeout(timer);
  }, [hasJob, plan]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTo({ top: node.scrollHeight });
  }, [hasJob, reading, setup.asking]);

  const send = (message: string) => {
    const clean = message.trim();
    if (!clean) return;
    setText("");
    onJob(clean);
  };
  const toComposer = () => setFocusKey((current) => current + 1);

  return (
    <>
      {header}
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" data-testid="new-agent-chat" data-agent={agent.id} data-step={!hasJob ? "job" : reading ? "reading" : setup.asking}>
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-5 py-6">
          {hasJob ? <UserBubble>{agent.said}</UserBubble> : (
            <>
              <AgentSays agent={agent}>Hi. What should I do for you? Tell me the way you would tell a new teammate.</AgentSays>
              <div className="pl-[30px]">
                <QuestionCard
                  testId="job-question"
                  question="Or start from one of these"
                  options={JOB_EXAMPLES.map((example) => example.label)}
                  other="Something else"
                  onPick={(index) => send(JOB_EXAMPLES[index]?.job ?? "")}
                  onOther={toComposer}
                />
              </div>
            </>
          )}
          {hasJob && reading ? <WorkingLine agent={agent} label="Reading your job" /> : null}
          {hasJob && !reading ? (
            <>
              <AgentSays agent={agent} testId="new-agent-plan">{plan}</AgentSays>
              <div className="flex flex-col gap-3 pl-[30px]">
                <QuestionCard
                  testId="start-question"
                  question="Start like this?"
                  options={["Yes, start", "Change how often"]}
                  other="Something else"
                  picked={setup.asking === "often" ? 1 : null}
                  onPick={(index) => (index === 0 ? onStart() : onAskOften("often"))}
                  onOther={toComposer}
                />
                {setup.asking === "often" ? (
                  <QuestionCard
                    testId="often-question"
                    question="How often should I check?"
                    options={OFTEN_CHOICES.map((choice) => choice.label)}
                    other="Something else"
                    onPick={(index) => onStart(OFTEN_CHOICES[index]?.schedule)}
                    onOther={toComposer}
                  />
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mx-auto w-full max-w-[720px]">
          <Composer
            value={text}
            onChange={setText}
            onSubmit={() => send(text)}
            placeholder={hasJob ? "Type your answer, or tell it something else" : "Tell it what to do"}
            focus
            focusKey={focusKey}
          />
        </div>
      </div>
    </>
  );
}
