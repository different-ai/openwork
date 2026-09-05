"use client";

import type { ReactNode } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, FileText, Folder, LayoutDashboard, MessageSquare, Network, Play, Plug, Search, Users, Workflow } from "lucide-react";
import styles from "./setup-frame.module.css";

const steps = [
  { id: "account", label: "Account" },
  { id: "space", label: "Your space" },
  { id: "people", label: "People" },
  { id: "tools", label: "Tools" },
  { id: "ready", label: "Get to work" },
];

export type SetupStep = "account" | "space" | "people" | "tools" | "ready";

function WorkPreview({ step }: { step: SetupStep }) {
  const gateway = step === "tools" || step === "ready";
  const label = gateway ? "One gateway. The tools you already use."
    : step === "space" ? "A useful workflow, ready to reuse."
    : step === "people" ? "Share the tools. Keep individual access."
    : "Go from a conversation to a working dashboard.";
  return (
    <figure className={styles.preview} aria-label={`Product example: ${label}`}>
      <div className={styles.previewLabel}><span>OPENWORK, IN PRACTICE</span><span>Example</span></div>
      <div className={styles.appWindow} aria-hidden="true">
        <div className={styles.appTitlebar}>
          <img src="/openwork-mark.svg" alt="" width={13} height={13} />
          <span>OpenWork</span><span className={styles.appWindowLabel}>{gateway ? "Connect" : step === "space" ? "Workflows" : step === "people" ? "Team library" : "Design studio"}</span>
        </div>
        {gateway ? (
          <div className={styles.gatewayCanvas}>
            <div className={styles.gatewaySources}><span><FileText size={12} /> Team skills</span><span><Plug size={12} /> Connections</span></div>
            <div className={styles.gatewayStem} />
            <div className={styles.gatewayHub}><span className={styles.gatewayMark}><img src="/openwork-mark.svg" alt="" width={19} height={19} /></span><div><strong>OpenWork gateway</strong><small>One MCP connection</small></div><Network size={18} /></div>
            <div className={styles.gatewayBranches}><i /><i /><i /></div>
            <div className={styles.gatewayClients}><span><img src="/openwork-mark.svg" alt="" width={18} height={18} />Desktop</span><span>Codex</span><span>Claude Code</span></div>
            <p className={styles.gatewayNote}>Your team’s tools, available in your agent.</p>
          </div>
        ) : (
          <div className={styles.appBody}>
            <div className={styles.appSidebar}><MessageSquare size={14} /><LayoutDashboard size={14} /><Workflow size={14} /><Users size={14} /><span /></div>
            <div className={styles.appContent}>
              {step === "space" ? (
                <>
                  <div className={styles.appBreadcrumb}>Workflows <ChevronRight size={10} /> Team brief</div>
                  <div className={styles.previewSectionTitle}>Weekly team brief <span>Reusable</span></div>
                  <div className={styles.workflowNode}><span><Search size={13} /></span><div><strong>Gather project updates</strong><small>From connected tools</small></div></div>
                  <div className={styles.workflowLine} />
                  <div className={styles.workflowNode}><span><MessageSquare size={13} /></span><div><strong>Summarize what changed</strong><small>Priorities, decisions, next steps</small></div></div>
                  <div className={styles.workflowLine} />
                  <div className={styles.workflowNode}><span><FileText size={13} /></span><div><strong>Create a team brief</strong><small>A document you can share</small></div></div>
                  <div className={styles.workflowFooter}><span>Inputs → work → result</span><span><Play size={9} /> Run workflow</span></div>
                </>
              ) : step === "people" ? (
                <>
                  <div className={styles.appBreadcrumb}>Library <ChevronRight size={10} /> Shared with your team</div>
                  <div className={styles.previewSectionTitle}>A common starting point</div>
                  <div className={styles.libraryRow}><span><FileText size={15} /></span><div><strong>Write a project brief</strong><small>Skill · Your team’s way of working</small></div><ArrowUpRight size={12} /></div>
                  <div className={styles.libraryRow}><span><Plug size={15} /></span><div><strong>Project knowledge</strong><small>Connection · Access managed by your team</small></div><ArrowUpRight size={12} /></div>
                  <div className={styles.libraryRow}><span><LayoutDashboard size={15} /></span><div><strong>Launch overview</strong><small>Dashboard · Shared with the team</small></div><ArrowUpRight size={12} /></div>
                  <div className={styles.libraryPeople}><span>Y</span><span>A</span><span>M</span><small>Shared tools. Individual accounts.</small></div>
                </>
              ) : (
                <>
                  <div className={styles.appBreadcrumb}><Folder size={10} /> Launch planning</div>
                  <div className={styles.previewPrompt}>Create a launch dashboard from my project files.<span><ArrowUpRight size={12} /></span></div>
                  <div className={styles.previewResponse}><img src="/openwork-mark.svg" alt="" width={12} height={12} /> A dashboard you can keep working with.</div>
                  <div className={styles.dashboardPreview}>
                    <div className={styles.dashboardHeading}><LayoutDashboard size={12} /><strong>Launch overview</strong><span>App preview</span></div>
                    <div className={styles.dashboardChart}><div><small>Milestones</small><strong>12 <span>/ 16</span></strong></div><svg viewBox="0 0 140 48" fill="none"><path d="M2 43 23 36 43 38 63 25 83 29 104 14 122 17 138 4" stroke="#252525" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M2 43 23 36 43 38 63 25 83 29 104 14 122 17 138 4V48H2Z" fill="#252525" fillOpacity=".04" /></svg></div>
                    <div className={styles.dashboardRow}><span><i /> Product page</span><small>Ready for review</small></div>
                    <div className={styles.dashboardRow}><span><i /> Launch checklist</span><small>In progress</small></div>
                  </div>
                  <div className={styles.previewInput}>Ask for a change…<ArrowRight size={12} /></div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <figcaption>{label}</figcaption>
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
          </div>
          {aside ? <div className={styles.customPreview}>{aside}</div> : <WorkPreview step={step} />}
          <p className={styles.storyNote}>{step === "tools" || step === "ready" ? "Connect once. Discover the right capability when your work needs it." : "Build dashboards, reuse workflows, and bring your team’s tools into the conversation."}</p>
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
