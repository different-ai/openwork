"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, Download, FileText, RotateCcw, Sparkles, Star } from "lucide-react";
import { CoworkerAvatar, CoworkerMark, type AvatarColor, type AvatarGlasses } from "./coworker-brand";

type Profile = { id: string; name: string; role: string; color: AvatarColor; glasses: AvatarGlasses; work: string; prompt: string };
const PROFILES: Profile[] = [
  { id: "polaris", name: "Polaris", role: "Your deep thinker", color: "violet", glasses: "star", work: "Find the decision that changes everything.", prompt: "Pressure-test our launch plan. Recommend one audience, show the trade-offs, and tell us what evidence would change your mind." },
  { id: "scout", name: "Scout", role: "Your research partner", color: "mint", glasses: "oval", work: "Less searching. More signal.", prompt: "Compare five alternatives with sources. Ask Polaris to challenge the recommendation before you write the final brief." },
  { id: "spark", name: "Spark", role: "Your launch partner", color: "orange", glasses: "round", work: "Turn a good angle into a whole campaign.", prompt: "Ask Polaris to pressure-test the positioning. Then draft a landing page, three launch posts, and a launch checklist. Don't publish anything." },
  { id: "forge", name: "Forge", role: "Your engineering partner", color: "blue", glasses: "square", work: "Think through the architecture. Ship the small fix.", prompt: "Prepare a plan for this feature. Ask Polaris to review the risky assumptions. Implement the smallest approved change and verify it." },
  { id: "relay", name: "Relay", role: "Your operations partner", color: "sage", glasses: "square", work: "Make repeatable work feel lighter.", prompt: "Turn these notes into owners, next actions, and a draft update. Ask before sending anything or changing a connected record." },
];
const MODELS = ["GPT-5.6 Luna", "GPT-6 Astra", "Gemini 3.8 Flash"];
const STEPS = ["Brief", "Think", "Work", "Review"];

function Face({ profile, size = 64 }: { profile: Profile; size?: number }) {
  return <CoworkerAvatar name={profile.name} identity={"constellation:" + profile.id} color={profile.color} glasses={profile.glasses} size={size} motion={size > 80 ? "presentation" : "attentive"} />;
}

function Constellation() {
  const [selected, setSelected] = useState(PROFILES[0]!);
  const [starGlasses, setStarGlasses] = useState(true);
  const sky = useRef<HTMLDivElement>(null);
  const [twinkle, setTwinkle] = useState(false);
  useEffect(() => {
    const element = sky.current;
    if (!element) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const update = () => setTwinkle(visible && !document.hidden && document.hasFocus() && !motion.matches);
    const observer = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); update(); });
    observer.observe(element);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    motion.addEventListener("change", update);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", update); window.removeEventListener("focus", update); window.removeEventListener("blur", update); motion.removeEventListener("change", update); };
  }, []);
  return <div ref={sky} className="dt-sky" data-twinkle={twinkle} aria-label="Meet your constellation">
    <svg className="dt-orbits" viewBox="0 0 520 490" fill="none" aria-hidden="true">
      <ellipse cx="270" cy="241" rx="226" ry="164" transform="rotate(-27 270 241)" />
      <ellipse cx="270" cy="241" rx="174" ry="212" transform="rotate(-27 270 241)" />
      <path d="M270 138L94 256L333 366L440 254L270 138" strokeDasharray="3 8" />
      <g className="dt-stars" fill="currentColor" stroke="none"><circle cx="56" cy="93" r="2" /><circle cx="452" cy="84" r="2" /><circle cx="182" cy="378" r="1.5" /><circle cx="474" cy="391" r="2" /><circle cx="210" cy="47" r="1.5" /><circle cx="385" cy="158" r="1.5" /><circle cx="36" cy="353" r="1.5" /><path d="M410 48l2 7 7 2-7 2-2 7-2-7-7-2 7-2zM164 158l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" /></g>
    </svg>
    {PROFILES.map((profile, i) => <button key={profile.id} className={"dt-planet dt-planet-" + i} onClick={() => setSelected(profile)} aria-pressed={selected.id === profile.id} aria-label={"Meet " + profile.name}>
      <Face profile={i === 0 ? { ...profile, glasses: starGlasses ? "star" : "round" } : profile} size={i === 0 ? 126 : 76} /><span>{profile.name}</span><small>{i === 0 ? "DEEP THINKER" : "COWORKER"}</small>
    </button>)}
    <div className="dt-sky-caption" aria-live="polite"><Star size={13} aria-hidden="true" /><span><strong>{selected.name}.</strong> {selected.work}</span></div>
    <button className="dt-star-toggle" aria-pressed={starGlasses} onClick={() => setStarGlasses(!starGlasses)}><Star size={11} aria-hidden="true" /> Star glasses {starGlasses ? "on" : "off"}<span>Just a little personality.</span></button>
  </div>;
}

function Handoff() {
  const [pattern, setPattern] = useState("three-models");
  const [conversation, setConversation] = useState(MODELS[0]!);
  const [thinker, setThinker] = useState(MODELS[1]!);
  const [worker, setWorker] = useState(MODELS[2]!);
  const [step, setStep] = useState(0);
  function preset(id: string) {
    setPattern(id); setStep(0);
    setConversation(id === "three-models" ? MODELS[0]! : MODELS[2]!);
    setThinker(id === "one-model" ? "" : MODELS[1]!); setWorker(id === "three-models" ? MODELS[2]! : "");
  }
  const workerModel = worker || conversation;
  const thinkerModel = thinker || conversation;
  const copy = [
    { who: "You", model: "One brief. A clear finish line.", text: "Help me launch our new product. Find the strongest angle, then draft the page and three posts. Keep everything as a draft.", receipt: "Goal · A launch kit ready for your review" },
    { who: "Deep-thinking Worker", model: thinkerModel + " · Bounded thinking", text: "Decision: lead with the first useful result. Constraints: one audience, no unsupported claims. Acceptance: a clear promise, a concrete example, and one small next step. Open risk: the strongest claim still needs evidence.", receipt: "Decision brief · Reusable criteria for delivery" },
    { who: "Spark’s Worker", model: workerModel + " · Bounded execution", text: "I turned the brief into a landing-page draft, three launch posts, and a checklist. One claim still needs a source; I left it flagged, not invented.", receipt: "Launch kit · 5 draft artifacts, nothing published" },
    { who: "Spark", model: conversation + " · Back in your conversation", text: "The launch kit is ready to review. The direction stayed consistent, and the unsupported claim is marked. You choose what leaves this workspace.", receipt: "Handoff complete · Review before any external action" },
  ][step]!;
  return <section id="handoff" className="dt-section dt-wrap">
    <div className="dt-section-heading"><div><p className="cw-eyebrow">A small team. A clear division of work.</p><h2>Not every task<br />needs a shooting star.</h2></div><p>One model to talk with. Another to think deeply. A lighter one to deliver. Or the same model for everything. You choose.</p></div>
    <div className="dt-patterns" role="group" aria-label="Example patterns">
      <button onClick={() => preset("three-models")} aria-pressed={pattern === "three-models"}>01 <strong>Three-model team</strong><span>Luna + Astra + Flash</span></button>
      <button onClick={() => preset("flash-first")} aria-pressed={pattern === "flash-first"}>02 <strong>Flash first</strong><span>Go deep only when needed</span></button>
      <button onClick={() => preset("one-model")} aria-pressed={pattern === "one-model"}>03 <strong>Keep it simple</strong><span>One model, every role</span></button>
    </div>
    <div className="dt-handoff">
      <div className="dt-controls">
        <p className="dt-label"><Sparkles size={14} aria-hidden="true" /> YOUR MODEL MIX</p>
        <p className="dt-small">Interactive concept. These choices do not configure the app or run models.</p>
        <label>Conversation model<select value={conversation} onChange={e => { setConversation(e.target.value); setPattern("custom"); }}>{MODELS.map(model => <option key={model}>{model}</option>)}</select></label>
        <label>Deep thinking model<select value={thinker} onChange={e => { setThinker(e.target.value); setPattern("custom"); }}><option value="">Same as coworker</option>{MODELS.map(model => <option key={model}>{model}</option>)}</select></label>
        <label>Delivery model<select value={worker} onChange={e => { setWorker(e.target.value); setPattern("custom"); }}><option value="">Same as coworker</option>{MODELS.map(model => <option key={model}>{model}</option>)}</select></label>
        <p className="dt-small dt-control-note">One illustrative recipe, not a required stack. The local app candidate uses your connected model catalog, not this example list. Worker choices are pinned when work starts.</p>
      </div>
      <div className="dt-story">
        <div className="dt-story-top"><span>Launch a product</span><span className="dt-demo-tag">SCRIPTED EXAMPLE</span></div>
        <div className="dt-steps" role="group" aria-label="Handoff steps">{STEPS.map((label, i) => <button key={label} onClick={() => setStep(i)} aria-pressed={step === i}><span>{i < step ? <Check size={12} aria-hidden="true" /> : i + 1}</span>{label}</button>)}</div>
        <div className="dt-message" aria-live="polite">
          {step > 0 ? <Face profile={PROFILES[step === 1 ? 0 : 2]!} size={48} /> : <span className="dt-you">Y</span>}
          <div><h3>{copy.who}</h3><p className="dt-small">{copy.model}</p><p className="dt-message-text">{copy.text}</p><div className="dt-receipt"><FileText size={16} aria-hidden="true" />{copy.receipt}</div></div>
        </div>
        <div className="dt-story-footer"><button className="dt-reset" onClick={() => setStep(0)} aria-label="Restart example"><RotateCcw size={15} aria-hidden="true" /></button><span>No inference. No account. No spend.</span><button className="dt-next" onClick={() => setStep((step + 1) % STEPS.length)}>{step === 3 ? "Play again" : "Next step"}<ArrowRight size={15} aria-hidden="true" /></button></div>
      </div>
    </div>
    <div className="dt-efficiency"><article><span>01 / SKIP THE CEREMONY</span><h3>Small ask? Just answer.</h3><p>Routine work doesn’t need a thinker. Your coworker stays the front door, without waiting on every delivery step.</p></article><article><span>02 / MAKE THINKING REUSABLE</span><h3>One brief. Clear criteria.</h3><p>Decisions, constraints, acceptance criteria, and file references. Don’t shuttle the whole transcript between models.</p></article><article><span>03 / BOUND THE HANDOFF</span><h3>Deliver. Check. Hand back.</h3><p>Up to two delivery Workers after one completed thinking brief. No recursive Workers. A blocker returns to the coworker.</p></article></div>
    <p className="dt-small dt-under-note">Two thinking turns by default; delivery has a finite turn budget. These are work bounds, not dollar caps. “Ask first” is a recommended profile instruction, not an enforced spending approval. Compact prompts and parallel work are opportunities, not measured speed guarantees.</p>
  </section>;
}

function CostSketch() {
  const [share, setShare] = useState(20);
  const [premiumInput, setPremiumInput] = useState("10");
  const [premiumOutput, setPremiumOutput] = useState("50");
  const [lightInput, setLightInput] = useState("1.5");
  const [lightOutput, setLightOutput] = useState("7.5");
  const values = [premiumInput, premiumOutput, lightInput, lightOutput];
  const valid = values.every(value => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 10000);
  const premium = 0.1 * Number(premiumInput) + 0.02 * Number(premiumOutput);
  const light = 0.1 * Number(lightInput) + 0.02 * Number(lightOutput);
  const mixed = premium * share / 100 + light * (1 - share / 100);
  const money = (value: number) => valid ? "$" + value.toFixed(2) : "—";
  return <section id="cost" className="dt-section dt-cost-band"><div className="dt-wrap dt-cost-grid">
    <div><p className="cw-eyebrow">Spend on the decisions. Not every keystroke.</p><h2>A bigger brain.<br />A smaller bill?</h2><p className="dt-lead">That’s the hypothesis. Here’s the math you can challenge.</p><p className="dt-small">Thinking + delivery only: 100,000 input + 20,000 output tokens, split in the same proportion across two models. Conversation/orchestration cost is excluded; this is not a whole-workflow estimate, benchmark, or savings promise.</p><details className="dt-assumptions"><summary>Edit rate assumptions <span>USD / 1M tokens</span></summary><div className="dt-rates">{[
      { label: "Astra input rate", value: premiumInput, set: setPremiumInput },
      { label: "Astra output rate", value: premiumOutput, set: setPremiumOutput },
      { label: "Flash input rate", value: lightInput, set: setLightInput },
      { label: "Flash output rate", value: lightOutput, set: setLightOutput },
    ].map(field => <label key={field.label}>{field.label}<input type="number" min="0" max="10000" step="0.01" value={field.value} onChange={e => field.set(e.target.value)} /></label>)}</div></details></div>
    <div className="dt-cost-card"><p className="dt-label">SAME ASSUMED TOKEN VOLUMES</p><div className="dt-cost-row"><span>All Astra</span><strong>{money(premium)}</strong></div><div className="dt-cost-row dt-cost-mixed"><span>Your model mix</span><strong data-testid="mixed-cost">{money(mixed)}</strong></div><label className="dt-range-label" htmlFor="thinking-share">Astra’s share <strong>{share}%</strong></label><input id="thinking-share" type="range" min="0" max="100" step="5" value={share} onChange={e => setShare(Number(e.target.value))} aria-valuetext={share + "% Astra, " + (100 - share) + "% Flash"} /><div className="dt-range-ends"><span>More Flash</span><span>More Astra</span></div><p className="dt-small" aria-live="polite">{valid ? share + "% Astra · " + (100 - share) + "% Flash. Planning, review, and handoff tokens must all count toward this split." : "Enter all four non-negative rates, up to $10,000 per million tokens."}</p></div>
    <p className="dt-small dt-cost-source">Rate assumptions checked September 8, 2026: Astra standard short-context $10 / $50; Flash $1.50 / $7.50 uses the announced post-promotion standard, not today’s introductory credit offer. Actual token volumes differ by model. Cache, tools, retries, long-context multipliers, and provider fees can change the result. OpenWork subscription allowance is not an API invoice. <a href="https://developers.openai.com/api/docs/models/gpt-6-astra">OpenAI rates ↗</a> · <a href="https://ai.google.dev/gemini-api/docs/latest-model">Google rates ↗</a></p>
  </div></section>;
}

export function DeepThinkerLaunch() {
  return <main className="cw dt-launch">
    <a className="dt-skip" href="#profiles">Skip to profiles</a>
    <div className="dt-preview-note">LOCAL LAUNCH EXPLORATION <span>Illustrative controls and replies · no model calls</span></div>
    <section className="dt-hero dt-wrap">
      <div className="dt-hero-copy"><div className="dt-brand"><CoworkerMark size={28} tile={false} /><span>Open Coworker</span><span className="dt-brand-divider" /><span className="dt-small">A new kind of team</span></div><p className="dt-hero-eyebrow"><Star size={12} fill="currentColor" aria-hidden="true" /> ASTRA, MEET YOUR COWORKERS.</p><h1>Think big.<br /><span>Work lean.</span></h1><p className="dt-hero-lead">A fast coworker. A deep thinker.<br />A lighter model for delivery.<br />You choose the mix.</p><div className="dt-hero-actions"><a className="cw-btn cw-btn--primary" href="#handoff">Try the handoff <ArrowRight size={16} aria-hidden="true" /></a><a className="dt-text-link" href="#profiles">Meet the constellation <ArrowDown size={14} aria-hidden="true" /></a></div><p className="dt-small">Luna + Astra + Flash is one recipe—not a requirement.<br />Any supported, connected models. Your team stays yours.</p></div>
      <Constellation />
    </section>
    <div className="dt-principle dt-wrap"><span>THE IDEA IS SIMPLE</span><p>Your best thinker doesn’t have to do every little thing.</p><Star size={20} aria-hidden="true" /></div>
    <Handoff />
    <section id="profiles" className="dt-section dt-wrap"><div className="dt-section-heading"><div><p className="cw-eyebrow">Meet the constellation</p><h2>Little personalities.<br />Real responsibilities.</h2></div><p>Start with a useful role, not a blank prompt. Give each coworker its own identity and memory. Change the model without changing who it is.</p></div><div className="dt-profile-grid">{PROFILES.map(profile => <article key={profile.id} className={"dt-profile dt-profile-" + profile.id}><div className="dt-profile-top"><Face profile={profile} size={profile.id === "polaris" ? 100 : 64} /><span className="dt-label">{profile.id === "polaris" ? "THE TURNING POINTS" : "THE EVERYDAY WORK"}</span></div><p className="dt-role">{profile.role}</p><h3>{profile.name}</h3><p className="dt-work">{profile.work}</p><blockquote>“{profile.prompt}”</blockquote><div className="dt-profile-bottom"><span>{profile.id === "polaris" ? "Try with Astra" : "Try with Flash"}</span><a href={"/coworker/profiles/" + profile.id + ".coworker.json"} download aria-label={"Download " + profile.name + " profile"}><Download size={15} aria-hidden="true" /> Profile</a></div></article>)}</div><p className="dt-small dt-under-note">Profile downloads contain role, instructions, and appearance only. Import a personal copy, then choose its model separately. They do not connect providers, grant tools, install a team, or start work.</p></section>
    <CostSketch />
    <section className="dt-section dt-wrap dt-choice"><p className="cw-eyebrow">Open means you choose.</p><h2>A constellation.<br />Not a walled garden.</h2><p>Choose supported models from different vendors. Keep your coworkers’ personalities, files, and memories. Make the trade-off yourself.</p><div className="dt-choice-items"><span><Check size={16} aria-hidden="true" /> Your model choices</span><span><Check size={16} aria-hidden="true" /> Your connected tools</span><span><Check size={16} aria-hidden="true" /> Your approval to publish</span></div><p className="dt-small">Local desktop does not mean local inference. Selected cloud models receive the context sent to them. Provider access, availability, terms, and organization policies still apply.</p><details><summary>What’s real, and what’s still an idea?</summary><p>Existing building blocks: persistent coworkers, per-coworker model choice, bounded Workers, and editable profile imports. The local candidate adds independent thinking/delivery model settings, pinned Worker choices, and a bounded thinking-to-delivery handoff. Native end-to-end verification is still pending; this page uses scripted replies.</p><p>Deferred: enforced escalation approvals, hard dollar budgets, and per-task cost receipts. No measured savings or speed improvement is promised.</p><p>Claude Code already offers planning/execution model splits. Our angle is visible cross-vendor choice for a persistent coworker team—not inventing multi-model work.</p></details><a className="dt-text-link" href="/coworker">Back to Open Coworker <ArrowRight size={16} aria-hidden="true" /></a></section>
    <footer className="dt-wrap dt-footer"><div className="dt-brand"><CoworkerMark size={22} tile={false} /> Open Coworker</div><p>A little constellation. A lot of work.</p><span>Independent concept · No provider sponsorship</span></footer>
  </main>;
}
