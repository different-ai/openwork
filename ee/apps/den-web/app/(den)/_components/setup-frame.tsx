"use client";

import type { ReactNode } from "react";
import { ArrowUpRight, Check, FileText, Folder, Layers, Plus, Users } from "lucide-react";
import styles from "./setup-frame.module.css";

const steps = [
  { id: "account", label: "Account" },
  { id: "space", label: "Your space" },
  { id: "people", label: "People" },
  { id: "ready", label: "Get to work" },
];

export type SetupStep = "account" | "space" | "people" | "ready";

function WorkPreview({ step }: { step: SetupStep }) {
  return (
    <div className={styles.preview} aria-hidden="true">
      <div className={styles.object}><i /><i /><i /></div>
      {step === "people" ? (
        <div className={styles.peoplePreview}>
          <div className={styles.faces}><span>Y</span><span>A</span><span>M</span><span><Plus size={18} /></span></div>
          <div className={styles.previewHeading}>Good work is better together.</div>
          <div className={styles.personRow}><span className={styles.smallAvatar}>Y</span><span>You</span><small>Owner</small></div>
          <div className={styles.personRow}><span className={styles.smallAvatar}>A</span><span>Your teammate</span><small>Member</small></div>
          <div className={styles.inviteLine}><Plus size={14} /> Room for your people</div>
        </div>
      ) : (
        <>
          <div className={styles.backCard}><Folder size={15} /><span>{step === "space" ? "A space for your team" : "Monday, with a head start"}</span><span className={styles.previewDots}>···</span></div>
          <div className={styles.workCard}>
            <div className={styles.promptLine}><span className={styles.promptIcon}><Layers size={17} /></span><span>{step === "space" ? "Your tools. In one place." : "Turn these notes into a plan."}</span><ArrowUpRight size={16} /></div>
            <div className={styles.paper}>
              <div className={styles.paperTop}><FileText size={18} /><span>{step === "space" ? "Team workspace" : "The week ahead"}</span><small>{step === "space" ? "YOUR SPACE" : "DRAFT"}</small></div>
              <div className={styles.paperRule} />
              {(step === "space" ? ["Tools your team can use", "Access you can manage", "Files that stay yours"] : ["A clear set of priorities", "The decisions that matter", "A useful place to start"]).map((line) => <div key={line} className={styles.paperRow}><Check size={13} /><span>{line}</span></div>)}
            </div>
            <div className={styles.cardFoot}><span><FileText size={12} /> Your files</span><span><Users size={12} /> Your context</span><span className={styles.previewArrow}><ArrowUpRight size={14} /></span></div>
          </div>
        </>
      )}
    </div>
  );
}

/** A shared visual rhythm from the first auth screen to the first useful task. */
export function SetupFrame({ step, title, description, children, aside, embedded = false }: {
  step: SetupStep;
  title: string;
  description: string;
  children: ReactNode;
  aside?: ReactNode;
  embedded?: boolean;
}) {
  const current = steps.findIndex((item) => item.id === step);
  return (
    <section className={`${styles.frame} ${embedded ? styles.embedded : ""}`} data-testid="setup-frame" data-step={step}>
      <header className={styles.top}>
        <div className={styles.brand}><img src="/openwork-mark.svg" alt="" width={25} height={25} /><span>OpenWork<span className={styles.cloud}> / Cloud</span></span></div>
        <nav aria-label="Setup progress"><ol className={styles.steps}>{steps.map((item, index) => (
          <li key={item.id} aria-current={item.id === step ? "step" : undefined} className={index < current ? styles.done : ""}>
            <span className={styles.stepNumber}>{index < current ? <Check size={12} /> : `0${index + 1}`}</span><span>{item.label}</span>
          </li>
        ))}</ol></nav>
      </header>
      <div className={styles.grid}>
        <aside className={styles.story}>
          <div className={styles.intro}>
            <p className={styles.eyebrow}>A LITTLE LESS BUSYWORK</p>
            <h1>{title}</h1>
            <p className={styles.description}>{description}</p>
          </div>
          {aside ?? <WorkPreview step={step} />}
          <p className={styles.storyNote}>{step === "people" ? "A shared space. Individual accounts. Everyone brings their own perspective." : "Documents, research, and the work in between. Start with what you want to get done."}</p>
        </aside>
        <div className={styles.panel} key={step}>
          <div className={styles.panelEyebrow}><span>0{current + 1}</span><span>{steps[current]?.label}</span><span className={styles.panelRule} /></div>
          {children}
        </div>
      </div>
      <footer className={styles.footer}><span>Built for work. With room for you.</span><span>Your desktop + your tools + your team</span></footer>
    </section>
  );
}
