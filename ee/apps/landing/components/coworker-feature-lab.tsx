"use client";

import { useState } from "react";
import {
  ArrowLeft, ArrowRight, Check, Copy, FileText, FolderOpen, Hand,
  LockKeyhole, Mail, MessageSquare, Monitor, MousePointer2, Play, Plug, RotateCcw,
  ShieldCheck, Square, Users, type LucideIcon,
} from "lucide-react";
import { CoworkerAvatar, CoworkerMark } from "./coworker-brand";
import { COWORKER_STARTERS, TEAM } from "../lib/coworker-demo";
import "./coworker-feature-lab.css";

type Feature = "computer" | "templates" | "connections";
type ComputerState = "off" | "discussion" | "working" | "paused" | "complete" | "revoked";
type ConnectionState = "picked" | "authorized" | "briefing";

const FEATURES: Array<{ id: Feature; label: string; detail: string; icon: LucideIcon }> = [
  { id: "templates", label: "Coworker templates", detail: "A useful starting point, made personal.", icon: Copy },
  { id: "connections", label: "Connected apps", detail: "Bring the right context into a discussion.", icon: Plug },
  { id: "computer", label: "Computer use", detail: "One task. One approved window.", icon: Monitor },
];

const COMPUTER_STATUS: Record<ComputerState, { title: string; detail: string }> = {
  off: { title: "Off for this sample discussion", detail: "Start with discussion opt-in. It does not start a task or grant window access." },
  discussion: { title: "Discussion opt-in previewed", detail: "No window approved. In the app, a separate native prompt asks you to select and approve the exact window." },
  working: { title: "Sample window approval illustrated", detail: "Only Launch checklist is in scope. Preview the result, or take over to pause this walkthrough. Nothing is running." },
  paused: { title: "You have control in this demo", detail: "The walkthrough is paused. Only your Continue button resumes it; no step or result advances while paused." },
  complete: { title: "Sample result ready for review", detail: "A completed turn closes its native session. Discussion opt-in can remain; another turn still needs fresh window approval. No work ran here." },
  revoked: { title: "Stopped & revoked in this demo", detail: "Both consent steps and the sample result are cleared. Nothing continues. Start again only with a new discussion opt-in preview." },
};

const SERVICES: Array<{
  id: "gmail" | "slack" | "drive";
  label: string;
  icon: LucideIcon;
  context: string;
  prompt: string;
  title: string;
  result: string;
}> = [
  {
    id: "gmail", label: "Gmail", icon: Mail,
    context: "Two fictional launch-planning emails",
    prompt: "Summarize the open decisions in these launch emails.",
    title: "Launch email briefing",
    result: "The announcement draft is ready. The launch example and release date still need a decision. Suggested next step: review both with the team.",
  },
  {
    id: "slack", label: "Slack", icon: MessageSquare,
    context: "Three fictional messages in #launch-planning",
    prompt: "Turn these launch updates into a short status note.",
    title: "Status note draft",
    result: "Ready: the announcement and walkthrough. Open: choose a launch example and confirm the release date. Next: agree on the two decisions before inviting early users.",
  },
  {
    id: "drive", label: "Drive", icon: FolderOpen,
    context: "A fictional launch brief and checklist",
    prompt: "Compare these two documents and brief me on the gaps.",
    title: "Document comparison briefing",
    result: "Both documents describe the same launch story. The checklist still needs an owner for early-user feedback, and neither document confirms a release date.",
  },
];

/** Deterministic illustrations only. No bridge, provider, or persistent state. */
export function CoworkerFeatureLab() {
  const [feature, setFeature] = useState<Feature>("templates");
  const [computer, setComputer] = useState<ComputerState>("off");
  const [starter, setStarter] = useState(COWORKER_STARTERS[0]!);
  const [templateMode, setTemplateMode] = useState<"file" | "team">("file");
  const [showCopy, setShowCopy] = useState(false);
  const [service, setService] = useState(SERVICES[0]!);
  const [connection, setConnection] = useState<ConnectionState>("picked");

  function resetExample() {
    setComputer("off");
    setStarter(COWORKER_STARTERS[0]!);
    setTemplateMode("file");
    setShowCopy(false);
    setService(SERVICES[0]!);
    setConnection("picked");
  }

  const canOptIn = computer === "off" || computer === "revoked";
  const discussionAllowed = !canOptIn;
  const windowApproved = computer === "working" || computer === "paused";
  const computerStatus = COMPUTER_STATUS[computer];
  const coworker = starter.coworker;
  const ops = TEAM[2]!;
  const scout = TEAM[0]!;
  const ServiceIcon = service.icon;

  return (
    <section id="possibilities" className="cw-lab" aria-labelledby="cw-lab-title" data-testid="coworker-feature-lab">
      <div className="cw-lab-layout">
        <div className="cw-lab-intro">
          <p className="cw-lab-disclosure"><ShieldCheck size={16} aria-hidden="true" />Interactive examples &middot; no live access</p>
          <p className="cw-lab-eyebrow">Make it your own</p>
          <h2 id="cw-lab-title">A coworker for<br />your way of working.</h2>
          <p className="cw-lab-lead">Start from a role, share a useful setup with your team, and add the tools each coworker needs.</p>
          <div className="cw-lab-features" role="group" aria-label="Feature examples">
            {FEATURES.map(({ id, label, detail, icon: Icon }) => (
              <button
                key={id}
                id={`cw-lab-choice-${id}`}
                type="button"
                className="cw-lab-feature"
                aria-label={label}
                aria-describedby={`cw-lab-detail-${id}`}
                aria-pressed={feature === id}
                aria-controls="cw-lab-panel"
                onClick={() => { if (id !== feature) { setFeature(id); resetExample(); } }}
              >
                <Icon size={19} aria-hidden="true" />
                <span className="cw-lab-feature-copy"><span className="cw-lab-feature-title">{label}</span><span id={`cw-lab-detail-${id}`} className="cw-lab-feature-detail">{detail}{id === "computer" ? <span className="cw-lab-badge">Development preview</span> : null}</span></span>
                <ArrowRight className="cw-lab-feature-arrow" size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
          <p className="cw-lab-intro-note">Fictional content, real product boundaries.<br />Switching examples starts a fresh walkthrough.</p>
        </div>

        <div id="cw-lab-panel" className="cw-lab-panel" role="region" aria-labelledby={`cw-lab-choice-${feature}`} data-testid="coworker-feature-panel" data-feature={feature}>
          <div className="cw-lab-chrome">
            <span className="cw-lab-chrome-title"><CoworkerMark size={22} />Open Coworker<span className="cw-lab-chrome-caption"> / feature preview</span></span>
            <button type="button" className="cw-lab-reset" onClick={resetExample}><RotateCcw size={13} aria-hidden="true" />Reset example</button>
          </div>

          {feature === "computer" ? (
            <div className="cw-lab-body">
              <div className="cw-lab-heading"><p className="cw-lab-kicker"><Monitor size={14} aria-hidden="true" />This Mac only<span className="cw-lab-badge">In development &middot; macOS 14+</span></p><h3>Your window. Your say.</h3><p>Two separate permissions, for a task you ask for in a saved private discussion.</p></div>
              {/* Guarded aria-disabled buttons stay mounted and retain keyboard focus as steps change. */}
              <ol className="cw-lab-consent" aria-label="Separate consent steps">
                <li>
                  <div className="cw-lab-step-heading"><span className="cw-lab-number">01</span><strong>Discussion opt-in</strong><span className="cw-lab-step-state">{discussionAllowed ? "Previewed" : "Off"}</span></div>
                  <p>Allow only this saved private discussion. macOS setup alone grants no discussion access.</p>
                  <button type="button" className="cw-lab-button cw-lab-button-primary" aria-disabled={!canOptIn} onClick={() => { if (canOptIn) setComputer("discussion"); }}>Preview discussion access<ArrowRight size={13} aria-hidden="true" /></button>
                </li>
                <li>
                  <div className="cw-lab-step-heading"><span className="cw-lab-number">02</span><strong>Exact-window approval</strong><span className="cw-lab-step-state">{windowApproved ? "Previewed" : computer === "complete" ? "Ended" : "Not granted"}</span></div>
                  <p>A separate native approval selects one window: the fictional Launch checklist below.</p>
                  <button type="button" className="cw-lab-button" aria-disabled={computer !== "discussion"} onClick={() => { if (computer === "discussion") setComputer("working"); }}>Approve sample window<ArrowRight size={13} aria-hidden="true" /></button>
                </li>
              </ol>

              <div className="cw-lab-window" data-state={computer} role="group" aria-label="Illustrated Launch checklist window, not a screen capture">
                <div className="cw-lab-window-bar"><span><FileText size={14} aria-hidden="true" />Launch checklist</span><span>Illustration, not a capture</span></div>
                <div className="cw-lab-document">
                  {windowApproved && <span className="cw-lab-pointer" aria-hidden="true"><MousePointer2 size={20} fill="currentColor" /><span>{computer === "paused" ? "You" : ops.name}</span></span>}
                  <div className="cw-lab-document-title"><h4>Before we launch</h4><span className="cw-lab-badge">Sample document</span></div>
                  <ul className="cw-lab-checklist">
                    <li><Check size={14} aria-hidden="true" /><span>Announcement draft</span><span>Ready</span></li>
                    <li><Square size={12} aria-hidden="true" /><span>Choose launch example</span><span>Open decision</span></li>
                    <li><Square size={12} aria-hidden="true" /><span>Confirm release date</span><span>Open decision</span></li>
                  </ul>
                  <div className="cw-lab-document-result" data-result={computer === "complete"}>
                    <CoworkerAvatar name={ops.name} color={ops.color} glasses={ops.glasses} size={30} animated={false} gaze={false} />
                    <p>{computer === "complete" ? "Step 2 of 2 / sample finding: choose the launch example and confirm the date before inviting early users. Both decisions remain yours." : computer === "paused" ? "Paused at the sample checklist. Continue returns to this step; it does not replay an action." : windowApproved ? "Step 1 of 2: inspect the sample checklist. Preview the read-only finding when you are ready." : "Task preview: ask Ops to identify the open decisions. No task has run and no window has been accessed."}</p>
                  </div>
                  <button type="button" className="cw-lab-text-button" aria-disabled={computer !== "working"} onClick={() => { if (computer === "working") setComputer("complete"); }}>Preview checklist result<ArrowRight size={13} aria-hidden="true" /></button>
                </div>
              </div>

              <div className="cw-lab-native-controls" role="group" aria-label="Illustrated native task controls" aria-describedby="cw-lab-computer-status">
                <span className="cw-lab-small-label">Native task panel &middot; illustrated controls</span>
                <div className="cw-lab-actions">
                  <button type="button" className="cw-lab-button" aria-disabled={computer !== "working"} onClick={() => { if (computer === "working") setComputer("paused"); }}><Hand size={14} aria-hidden="true" />Take over (demo)</button>
                  <button type="button" className="cw-lab-button" aria-disabled={computer !== "paused"} onClick={() => { if (computer === "paused") setComputer("working"); }}><Play size={13} aria-hidden="true" />Continue (demo)</button>
                  <button type="button" className="cw-lab-button cw-lab-button-stop" aria-disabled={!discussionAllowed} onClick={() => { if (discussionAllowed) setComputer("revoked"); }}><Square size={12} aria-hidden="true" />Stop &amp; revoke (demo)</button>
                </div>
              </div>
              <div id="cw-lab-computer-status" className="cw-lab-status" role="status" aria-atomic="true" data-testid="computer-preview-status" data-state={computer}><LockKeyhole size={16} aria-hidden="true" /><div><strong>{computerStatus.title}</strong><p>{computerStatus.detail}</p></div></div>
              <p className="cw-lab-boundary">Never whole-computer access. Groups, Workers and schedules do not inherit permission. This page never opens a native prompt.</p>
              <p className="cw-lab-availability">Native computer-control verification remains incomplete. Remote computers are not available.</p>
            </div>
          ) : null}

          {feature === "templates" ? (
            <div className="cw-lab-body">
              <div className="cw-lab-heading"><p className="cw-lab-kicker"><Copy size={14} aria-hidden="true" />A starting point, not shared memory</p><h3>Pass on the role.<br />Keep the work personal.</h3><p>Explore a starter, then see what a teammate would receive as their own working copy.</p></div>
              <div className="cw-lab-segment" role="group" aria-label="Coworker starters">
                {COWORKER_STARTERS.map((item) => <button key={item.id} type="button" aria-pressed={starter.id === item.id} onClick={() => { if (starter.id !== item.id) { setStarter(item); setShowCopy(false); } }}>{item.label}</button>)}
              </div>
              <div className="cw-lab-profile" role="status" aria-atomic="true" data-testid="template-preview" data-state={showCopy ? "personal-copy" : "starting-profile"} data-starter={starter.id}>
                <div className="cw-lab-profile-header">
                  <CoworkerAvatar name={coworker.name} color={coworker.color} glasses={coworker.glasses} size={64} animated={false} gaze={false} />
                  <div><p className="cw-lab-small-label">{showCopy ? "Teammate's own copy / local demo" : "Starting profile / local demo"}</p><h4>{coworker.name}</h4><p>{coworker.role}</p></div>
                </div>
                <dl className="cw-lab-profile-details">
                  <div><dt>Mission</dt><dd>{coworker.mission}</dd></div>
                  <div><dt>Responsibilities</dt><dd><ul>{coworker.responsibilities.map((item) => <li key={item}><Check size={13} aria-hidden="true" />{item}</li>)}</ul></dd></div>
                  <div><dt>Reusable instructions</dt><dd>Use the sources provided. Separate facts from assumptions. Prepare drafts for the person to review.</dd></div>
                </dl>
                <p className="cw-lab-copy-note"><LockKeyhole size={14} aria-hidden="true" />{showCopy ? "Their own conversations, documents and memory start here, independently. No prior work comes across. Nothing was sent or shared." : "This preview packages a starting profile and reusable instructions, not the coworker's personal history."}</p>
              </div>
              <div className="cw-lab-segment cw-lab-distribution" role="group" aria-label="Template delivery examples">
                <button type="button" aria-pressed={templateMode === "file"} onClick={() => { if (templateMode !== "file") { setTemplateMode("file"); setShowCopy(false); } }}><FileText size={14} aria-hidden="true" />Template file</button>
                <button type="button" aria-pressed={templateMode === "team"} onClick={() => { if (templateMode !== "team") { setTemplateMode("team"); setShowCopy(false); } }}><Users size={14} aria-hidden="true" />Team distribution</button>
              </div>
              <p className="cw-lab-mode-note">{templateMode === "file" ? "In the app, a .coworker.json template can be imported as a personal copy. This example does not export or download a file." : "Opt-in organization preview, off by default and not generally available. An enabled organization can assign starters; each person gets their own working copy."}</p>
              <div className="cw-lab-package">
                <div><h4><Check size={14} aria-hidden="true" />Included</h4><p>Starting profile, role, mission, responsibilities and explicitly reusable instructions.</p></div>
                <div><h4><LockKeyhole size={14} aria-hidden="true" />Not included</h4><p>Personal memory, conversations, documents or credentials. No model choices, schedules or active tasks.</p></div>
              </div>
              <button type="button" className="cw-lab-button cw-lab-button-primary" onClick={() => setShowCopy(!showCopy)}>{showCopy ? <ArrowLeft size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{showCopy ? "Back to template" : "Preview a teammate\u2019s copy"}</button>
              <p className="cw-lab-boundary">A personal copy, not multiplayer or memory sync. Each person uses their own account and organization access. No teammate is contacted in this demo.</p>
            </div>
          ) : null}

          {feature === "connections" ? (
            <div className="cw-lab-body">
              <div className="cw-lab-heading"><p className="cw-lab-kicker"><Plug size={14} aria-hidden="true" />Connected through OpenWork</p><h3>The right context.<br />A more useful answer.</h3><p>Choose one service to explore its example. Choosing is not connecting.</p></div>
              <div className="cw-lab-segment cw-lab-services" role="group" aria-label="Connected app examples">
                {SERVICES.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" aria-pressed={service.id === item.id} onClick={() => { if (service.id !== item.id) { setService(item); setConnection("picked"); } }}><Icon size={16} aria-hidden="true" />{item.label}</button>; })}
              </div>
              <ol className="cw-lab-connection-steps" aria-label="How an app connection works">
                <li aria-current={connection === "picked" ? "step" : undefined}><span className="cw-lab-number">01</span><div><strong>Pick service</strong><p>{service.label} example selected. No access granted.</p></div></li>
                <li aria-current={connection === "authorized" ? "step" : undefined}><span className="cw-lab-number">02</span><div><strong>Authorize with provider</strong><p>Organization setup may be needed. Your account and organization access apply.</p></div></li>
                <li aria-current={connection === "briefing" ? "step" : undefined}><span className="cw-lab-number">03</span><div><strong>Ask in discussion</strong><p>Use the authorized service for a specific request, not automatic access to every app.</p></div></li>
              </ol>
              <div className="cw-lab-actions">
                <button type="button" className="cw-lab-button cw-lab-button-primary" aria-disabled={connection !== "picked"} onClick={() => { if (connection === "picked") setConnection("authorized"); }}>Preview authorized connection<ArrowRight size={14} aria-hidden="true" /></button>
                <button type="button" className="cw-lab-button" aria-disabled={connection !== "authorized"} onClick={() => { if (connection === "authorized") setConnection("briefing"); }}>Preview discussion briefing<ArrowRight size={14} aria-hidden="true" /></button>
              </div>
              <div className="cw-lab-discussion">
                <div className="cw-lab-context"><ServiceIcon size={15} aria-hidden="true" /><div><strong>{service.label} / fictional context</strong><p>{service.context}</p></div><span className="cw-lab-badge">Read-only example</span></div>
                <p className="cw-lab-request"><span className="cw-lab-small-label">Example request</span>{service.prompt}</p>
                <div className="cw-lab-briefing" role="status" aria-atomic="true" data-testid="connection-preview" data-state={connection} data-service={service.id}>
                  <CoworkerAvatar name={scout.name} color={scout.color} glasses={scout.glasses} size={34} animated={false} gaze={false} />
                  <div><h4>{connection === "briefing" ? service.title : connection === "authorized" ? "Authorization illustrated, not performed" : "No service connected"}</h4><p>{connection === "briefing" ? service.result : connection === "authorized" ? `The illustration now assumes permission for ${service.label}. Preview a discussion briefing using only the fictional context shown here.` : `Preview the ${service.label} authorization step first. This page does not sign you in, read your account, or request provider access.`}</p><span className="cw-lab-small-label">{connection === "briefing" ? "Sample only. Nothing sent, posted or changed." : "Local demo / no live service access"}</span></div>
                </div>
              </div>
              <p className="cw-lab-boundary"><ShieldCheck size={15} aria-hidden="true" />A connection never grants blanket access. Available services and permissions depend on your account and organization. All content here is fixed sample data.</p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
