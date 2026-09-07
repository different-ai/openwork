"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, Check } from "lucide-react";
import { AvatarControls, CoworkerAvatar, acknowledgeCoworker } from "./coworker-brand";
import { PERSONALITY_OPTIONS, previewSayings } from "../../../../apps/coworker/src/lib/personalities";
import { COWORKER_STARTERS, type DemoCoworker } from "../lib/coworker-demo";

/** The app's two creation steps, using its actual avatar/appearance components
 * and personality catalog, with a local-only submit instead of the desktop bridge. */
export function CoworkerDemoBuilder({ value, identity, animated, onChange, onCreate }: {
  identity: string; animated: boolean;
  value: DemoCoworker; onChange: (next: DemoCoworker) => void; onCreate: () => void;
}) {
  const [step, setStep] = useState<"identity" | "details">("identity");
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) { firstStep.current = false; return; }
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest(".cw-demo-builder-fields")?.scrollTo({ top: 0, behavior: "auto" });
    heading.current?.closest(".cw-demo")?.scrollIntoView({ block: "start", behavior: "auto" });
  }, [step]);
  const saying = previewSayings(value.personality, value.name, 1)[0];
  const complete = value.name.trim() && value.role.trim() && value.mission.trim() && value.responsibilities.every((item) => item.trim());
  return <div className="cw-demo-builder">
    <aside className="cw-demo-builder-preview" aria-label="Live coworker preview">
      <CoworkerAvatar name={value.name || "Your coworker"} identity={identity} animated={animated} motion="presentation" color={value.color} glasses={value.glasses} size={104} />
      <div><h4>{value.name.trim() || "Your coworker"}</h4><p>{value.role.trim() || "A role you choose"}</p>
        <ul className="cw-demo-preview-responsibilities" aria-label="Preview responsibilities">{value.responsibilities.map((item, index) => <li key={index}><Check size={12} aria-hidden="true" /><span>{item.trim() || "A responsibility you choose"}</span></li>)}</ul>
        <span className="cw-demo-personality-preview" data-testid="demo-personality-preview">{saying || "Working"}…</span>
      </div>
    </aside>
    <form className="cw-demo-builder-form" onSubmit={(event) => { event.preventDefault(); if (step === "identity") setStep("details"); else if (complete) onCreate(); }}>
      <div className="cw-demo-builder-fields">
      <div className="cw-demo-step-label"><span className={step === "identity" ? "is-current" : ""}>01 · Your coworker</span><span className={step === "details" ? "is-current" : ""}>02 · Responsibilities</span></div>
      <h4 ref={heading} tabIndex={-1}>{step === "identity" ? "Who would help you most?" : "Give it a part to play."}</h4>
      <p className="cw-demo-description">{step === "identity" ? "Start with an example. Change the name, the look, and the work it will help with." : "Edit the work you’d like this coworker to take care of."}</p>
      {step === "identity" ? <>
        <div className="cw-demo-starters" role="group" aria-label="Example coworker roles">{COWORKER_STARTERS.map((starter) => <button type="button" key={starter.id} aria-label={"Start with " + starter.label} aria-pressed={value.role === starter.coworker.role} onClick={() => { if (animated) acknowledgeCoworker(identity); onChange({ ...starter.coworker, responsibilities: [...starter.coworker.responsibilities] }); }}>{starter.label}</button>)}</div>
        <label className="cw-demo-field">Name<input name="demo-name" aria-label="Coworker name" value={value.name} maxLength={32} required onChange={(event) => onChange({ ...value, name: event.target.value })} autoComplete="off" /></label>
        <div className="cw-demo-avatar-controls"><AvatarControls color={value.color} glasses={value.glasses} onColorChange={(color) => { if (animated && color !== value.color) acknowledgeCoworker(identity); onChange({ ...value, color }); }} onGlassesChange={(glasses) => { if (animated && glasses !== value.glasses) acknowledgeCoworker(identity); onChange({ ...value, glasses }); }} /></div>
      </> : <>
        <fieldset className="cw-demo-responsibility-fields"><legend>What it takes care of</legend>{value.responsibilities.map((item, index) => <label className="cw-demo-field" key={index}><span className="sr-only">Responsibility {index + 1}</span><input aria-label={"Responsibility " + (index + 1)} value={item} maxLength={90} required onChange={(event) => onChange({ ...value, responsibilities: value.responsibilities.map((current, position) => position === index ? event.target.value : current) })} autoComplete="off" /></label>)}</fieldset>
        <label className="cw-demo-field">Role<input name="demo-role" aria-label="Coworker role" maxLength={60} required value={value.role} onChange={(event) => onChange({ ...value, role: event.target.value })} autoComplete="off" /></label>
        <label className="cw-demo-field">Mission<textarea name="demo-mission" aria-label="Coworker mission" maxLength={180} required rows={2} value={value.mission} onChange={(event) => onChange({ ...value, mission: event.target.value })} /></label>
        <details className="cw-demo-personality-details"><summary data-testid="demo-personality-details">Personality</summary><fieldset className="cw-demo-personalities"><legend className="sr-only">Personality style</legend><div>{PERSONALITY_OPTIONS.filter((option) => ["neutral", "warm", "curious", "thoughtful"].includes(option.id)).map((option) => <button type="button" key={option.id} aria-pressed={value.personality === option.id} onClick={() => onChange({ ...value, personality: option.id })}>{option.label}</button>)}</div></fieldset><p className="mt-3 text-[11px] leading-5 text-[var(--cw-muted)]">Personality changes the wording while working. Role and mission give the work its direction.</p></details>
      </>}
      <p className="mt-4 text-[10px] leading-5 text-[var(--cw-muted)]">Try a fictional coworker. These details stay in this page and clear on reset.</p>
      </div>
      <div className="cw-demo-builder-actions">{step === "identity" ? <button type="button" className="cw-demo-small-button" onClick={() => setStep("details")} disabled={!value.name.trim()}>Set responsibilities<ArrowRight size={14} aria-hidden="true" /></button> : <><button type="button" className="cw-demo-text-button" onClick={() => setStep("identity")}><ChevronLeft size={14} aria-hidden="true" />Name & look</button><button type="submit" className="cw-demo-small-button" disabled={!complete}>Add coworker<Check size={14} aria-hidden="true" /></button></>}</div>
    </form>
  </div>;
}
