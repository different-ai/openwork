"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export function CoworkerDemoModels({ value, onChange }: { value: "free" | "models"; onChange: (value: "free" | "models") => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  return <div className="cw-demo-model-picker" ref={root} onKeyDown={(event) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button type="button" ref={trigger} aria-label="Choose a demo model" aria-expanded={open} aria-controls="demo-model-options" onClick={() => setOpen(!open)} data-testid="demo-model-source">{value === "free" ? "Free model" : "OpenWork Models"}<ChevronDown size={12} aria-hidden="true" /></button>
    {open && <div id="demo-model-options" className="cw-demo-model-options" role="group" aria-label="Model sources">
      {([{ id: "free", name: "Free model", detail: "A starting point for your first tasks." }, { id: "models", name: "OpenWork Models", detail: "Explore managed models and monthly membership." }] satisfies Array<{ id: "free" | "models"; name: string; detail: string }>).map((option) => <button type="button" key={option.id} aria-pressed={value === option.id} aria-label={"Use " + option.name + " in demo"} onClick={() => { onChange(option.id); setOpen(false); trigger.current?.focus(); }}><span><strong>{option.name}</strong><small>{option.detail}</small></span>{value === option.id && <Check size={14} aria-hidden="true" />}</button>)}
    </div>}
  </div>;
}
