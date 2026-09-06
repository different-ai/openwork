"use client";

import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, ChevronDown, ChevronRight, FileText, Folder, LayoutDashboard, MessageSquare, Network, Paperclip, Play, Plug, Search, Users, Workflow } from "lucide-react";
import styles from "./setup-frame.module.css";

const steps = [
  { id: "account", label: "Account" },
  { id: "space", label: "Your space" },
  { id: "tools", label: "Tools" },
  { id: "people", label: "People" },
  { id: "ready", label: "Review & finish" },
];

export type SetupStep = "account" | "space" | "people" | "tools" | "ready";

const exampleCopy: Record<SetupStep, { request: string; reply: string; caption: string }> = {
  account: { request: "Create a launch dashboard from my project files.", reply: "Here’s a dashboard you can keep working with.", caption: "Ask in chat. Get a dashboard you can use." },
  space: { request: "Turn our weekly project updates into a reusable workflow.", reply: "Here’s a workflow your team can run again.", caption: "Describe the work once. Reuse the workflow." },
  people: { request: "Draft a project brief using our team’s template.", reply: "I found your team’s shared skill and project knowledge.", caption: "Your team’s tools, right in the conversation." },
  tools: { request: "What tools can help with my project update?", reply: "These team tools can help. Connect your account to get started.", caption: "Discover the right tool when the task needs it." },
  ready: { request: "Summarize our project updates into a team brief.", reply: "Here’s a draft built with your team’s tools.", caption: "One conversation. Your models, tools, and results." },
};

function PreviewComposer() {
  return (
    <div className={styles.previewComposer}>
      <div className={styles.composerPlaceholder}>Ask for a change…</div>
      <div className={styles.composerToolbar}>
        <Paperclip size={12} />
        <span className={styles.composerModel}>OpenAI <ChevronDown size={10} /></span>
        <span className={styles.composerSend}><ArrowRight size={11} /></span>
      </div>
      <div className={styles.composerProviders}>Or choose Anthropic, Google, and more</div>
    </div>
  );
}

function WorkPreview({ step }: { step: SetupStep }) {
  const copy = exampleCopy[step];
  const gateway = step === "tools" || step === "ready";
  return (
    <figure className={styles.preview} aria-label={`Product example: ${copy.caption}`}>
      <div className={styles.previewLabel}><span>OPENWORK, IN PRACTICE</span><span>Example</span></div>
      <div className={styles.appWindow} aria-hidden="true">
        <div className={styles.appTitlebar}>
          <img src="/openwork-mark.svg" alt="" width={13} height={13} />
          <span>OpenWork</span><span className={styles.appWindowLabel}>New conversation</span>
        </div>
        <div className={styles.appBody}>
          <div className={styles.appSidebar}><MessageSquare size={14} /><LayoutDashboard size={14} /><Workflow size={14} /><Users size={14} /><span /></div>
          <div className={styles.appContent}>
            <div className={styles.appBreadcrumb}><Folder size={10} /> Team workspace <ChevronRight size={10} /> Chat</div>
            <div className={styles.previewPrompt}><span>You</span><p>{copy.request}</p></div>
            <div className={styles.previewResponse}><img src="/openwork-mark.svg" alt="" width={13} height={13} /><p>{copy.reply}</p></div>
            {step === "space" ? (
              <div className={styles.inlineResult}>
                <div className={styles.previewSectionTitle}><Workflow size={12} /> Weekly team brief <span>Workflow</span></div>
                <div className={styles.workflowNode}><span><Search size={12} /></span><div><strong>Gather project updates</strong><small>From connected tools</small></div></div>
                <div className={styles.workflowLine} />
                <div className={styles.workflowNode}><span><MessageSquare size={12} /></span><div><strong>Summarize what changed</strong><small>Priorities, decisions, next steps</small></div></div>
                <div className={styles.workflowLine} />
                <div className={styles.workflowNode}><span><FileText size={12} /></span><div><strong>Create a team brief</strong><small>A document you can share</small></div></div>
                <div className={styles.workflowFooter}><span>Ready to reuse</span><span><Play size={9} /> Run workflow</span></div>
              </div>
            ) : step === "people" || step === "tools" ? (
              <div className={styles.inlineResult}>
                <div className={styles.previewSectionTitle}><Plug size={12} /> Available from your team</div>
                <div className={styles.libraryRow}><span><FileText size={14} /></span><div><strong>Write a project brief</strong><small>Shared skill · Your team’s format</small></div><ArrowUpRight size={12} /></div>
                <div className={styles.libraryRow}><span><Plug size={14} /></span><div><strong>Project knowledge</strong><small>{step === "tools" ? "Connection · Your account needed" : "Connection · Team-managed access"}</small></div></div>
                {step === "tools"
                  ? <div className={styles.inlineAction}><span>Connect account</span><small>Sign in when you need it</small></div>
                  : <div className={styles.inlineDocument}><FileText size={12} /><span>Project brief</span><small>Draft</small><ArrowUpRight size={11} /></div>}
              </div>
            ) : step === "ready" ? (
              <div className={styles.inlineResult}>
                <div className={styles.previewSectionTitle}><FileText size={12} /> Team brief <span>Draft</span></div>
                <div className={styles.briefRow}><span>01</span><strong>Decisions to carry forward</strong></div>
                <div className={styles.briefRow}><span>02</span><strong>Next steps and owners</strong></div>
                <div className={styles.briefRow}><span>03</span><strong>Questions still open</strong></div>
                <div className={styles.inlineDocument}><FileText size={12} /><span>Open document</span><ArrowUpRight size={11} /></div>
              </div>
            ) : (
              <div className={styles.dashboardPreview}>
                <div className={styles.dashboardHeading}><LayoutDashboard size={12} /><strong>Launch overview</strong><span>App preview</span></div>
                <div className={styles.dashboardChart}><div><small>Milestones</small><strong>12 <span>/ 16</span></strong></div><svg viewBox="0 0 140 48" fill="none"><path d="M2 43 23 36 43 38 63 25 83 29 104 14 122 17 138 4" stroke="#252525" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 43 23 36 43 38 63 25 83 29 104 14 122 17 138 4V48H2Z" fill="#252525" fillOpacity=".04" /></svg></div>
                <div className={styles.dashboardRow}><span><i /> Product page</span><small>Ready for review</small></div>
                <div className={styles.dashboardRow}><span><i /> Launch checklist</span><small>In progress</small></div>
              </div>
            )}
            {gateway ? <div className={styles.gatewayContext}><Network size={12} /><div><strong>OpenWork gateway</strong><small>Team tools in Desktop, Codex, and Claude Code</small></div></div> : null}
            <PreviewComposer />
          </div>
        </div>
      </div>
      <figcaption>{copy.caption}</figcaption>
    </figure>
  );
}

/** A shared visual rhythm from the first auth screen to the first useful task. */
export function SetupFrame({ step, title, description, children, aside, panelVisual, embedded = false }: {
  step: SetupStep;
  title: string;
  description: string;
  children: ReactNode;
  aside?: ReactNode;
  panelVisual?: ReactNode;
  embedded?: boolean;
}) {
  const current = steps.findIndex((item) => item.id === step);
  return (
    <section className={`${styles.frame} ${embedded ? styles.embedded : ""}`} data-testid="setup-frame" data-step={step}>
      <header className={styles.top}>
        <div className={styles.brand}><img src="/openwork-mark.svg" alt="" width={25} height={25} /><span>OpenWork<span className={styles.cloud}> / Cloud</span></span></div>
        <nav className={styles.progress} aria-label="Setup progress">
          <div className={styles.progressSummary}>
            <span>{steps[current]?.label}</span>
            <span>Step {current + 1} of {steps.length}</span>
          </div>
          <ol className={styles.steps}>{steps.map((item, index) => (
            <li
              key={item.id}
              aria-current={item.id === step ? "step" : undefined}
              aria-label={`${item.label}: ${index < current ? "completed" : index === current ? "current step" : "upcoming"}`}
              className={index < current ? styles.done : ""}
            >
              <span className={styles.stepLabel}>{item.label}</span>
              <span className={styles.progressSegment} aria-hidden="true" />
            </li>
          ))}</ol>
        </nav>
      </header>
      <div className={styles.grid}>
        <aside className={styles.story}>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>A LITTLE LESS BUSYWORK</p>
            <h1>{title}</h1>
            <p className={styles.description}>{description}</p>
            <div className={styles.modelSupport}>
              <p>Your choice of model. One place to work.</p>
              <span>OpenAI</span><i aria-hidden="true">·</i><span>Anthropic</span><i aria-hidden="true">·</i><span>Google</span><i aria-hidden="true">·</i><span>and more</span>
            </div>
          </div>
          {aside ? <div className={styles.customPreview}>{aside}</div> : <WorkPreview step={step} />}
          <p className={styles.storyNote}>Switch models while keeping your tools and the work in one place.</p>
        </aside>
        <div className={styles.panel} key={step}>
          {panelVisual ? <div className={styles.panelVisual}>{panelVisual}</div> : null}
          <div className={styles.panelEyebrow}><span>0{current + 1}</span><span>{steps[current]?.label}</span><span className={styles.panelRule} /></div>
          {children}
        </div>
      </div>
      <footer className={styles.footer}><span>Built for work. With room for you.</span><span>Your desktop + your tools + your team</span></footer>
    </section>
  );
}
