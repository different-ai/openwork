"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { CoworkerEffortSlider } from "@openwork/ui/coworker-effort";

const STOPS = [
  { id: "light", label: "Light", detail: "Keep everyday questions quick and light." },
  { id: "steady", label: "Steady", detail: "A little more room to work through the details." },
  { id: "balanced", label: "Balanced", detail: "Quick questions stay quick. Deeper work gets more attention." },
  { id: "thorough", label: "Thorough", detail: "Give planning and research more room to think." },
  { id: "all-in", label: "All in", detail: "Your strongest preference for depth. More time and allowance may be used." },
];

/** The app's real slider, with sample-only state and no model requests. */
export function CoworkerDemoEffort({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const panelId = useId();
  const stop = STOPS[value]!;
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <div ref={root} className="cw-demo-effort" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" ref={trigger} className="cw-demo-effort-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} data-testid="demo-effort-toggle" onClick={() => setOpen(!open)}><SlidersHorizontal size={13} aria-hidden="true" /><span>Dynamic effort</span><span className="cw-demo-effort-value">{stop.label}</span><ChevronDown size={12} aria-hidden="true" /></button>
    {open && <div id={panelId} className="cw-demo-effort-panel" role="dialog" aria-label="Preview Dynamic effort" data-testid="effort-dial-panel" data-stop={stop.id}>
      <p className="cw-demo-effort-heading">Dynamic effort<span>You set the pace. Your coworker adapts to the task.</span></p>
      <div className="cw-demo-effort-title"><strong id={labelId} className="effort-dial-name">{stop.label}</strong>{value !== 2 && <button type="button" data-testid="demo-effort-reset" onClick={() => onChange(2)}>Reset</button>}</div>
      <p className="cw-demo-effort-description">{stop.detail}</p>
      <CoworkerEffortSlider index={value} stop={stop.id} label={stop.label} labelId={labelId} onChange={onChange} />
      <div className="cw-demo-effort-stops">{STOPS.map((item, index) => <button type="button" key={item.id} aria-pressed={value === index} onClick={() => onChange(index)}>{item.label}</button>)}</div>
      <p className="cw-demo-effort-disclosure">Preview the control. Replies in this demo are scripted.</p>
    </div>}
  </div>;
}
