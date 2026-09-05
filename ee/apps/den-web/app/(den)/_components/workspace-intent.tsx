"use client";

import { Check, Laptop, Users, LogIn, LockKeyhole, SlidersHorizontal } from "lucide-react";

export type WorkspaceIntent = "personal" | "team" | "join";
export type DesktopSetup = "flexible" | "restricted";

export function WorkspaceIntentChoices({ intent, onChange, disabled }: {
  intent: WorkspaceIntent | null;
  onChange: (intent: WorkspaceIntent) => void;
  disabled: boolean;
}) {
  return <fieldset disabled={disabled} className="grid gap-2.5">
    <legend className="mb-3 text-xs font-medium text-gray-500">How will you use OpenWork?</legend>
    {([
      { id: "personal", icon: Laptop, title: "On my own", copy: "Your own tools and projects. Room to grow later." },
      { id: "team", icon: Users, title: "Create a team", copy: "Shared tools and a place to work together." },
      { id: "join", icon: LogIn, title: "Join a team", copy: "Bring an invitation. Your team has a place for you." },
    ] satisfies Array<{ id: WorkspaceIntent; icon: typeof Laptop; title: string; copy: string }>).map((option) => <label key={option.id} className={`group relative flex cursor-pointer items-center gap-3.5 rounded-[14px] border p-4 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gray-600 ${intent === option.id ? "border-gray-900 bg-[#fafafa]" : "border-gray-200 bg-white hover:border-gray-400"}`}>
      <input type="radio" name="workspace-intent" value={option.id} checked={intent === option.id} onChange={() => onChange(option.id)} className="sr-only" />
      <span className={`grid size-9 shrink-0 place-items-center rounded-[10px] ${intent === option.id ? "bg-gray-900 text-white" : "border border-gray-100 bg-white text-gray-600"}`}><option.icon className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1"><span className="text-[13px] font-medium text-gray-950">{option.title}</span><span className="mt-1 block text-[11px] leading-5 text-gray-500">{option.copy}</span></span>
      <span aria-hidden="true" className={`grid size-4 shrink-0 place-items-center rounded-full border ${intent === option.id ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"}`}>{intent === option.id ? <Check size={10} /> : null}</span>
    </label>)}
  </fieldset>;
}

export function DesktopSetupChoices({ mode, onChange, disabled }: {
  mode: DesktopSetup | null;
  onChange: (mode: DesktopSetup) => void;
  disabled: boolean;
}) {
  return <fieldset disabled={disabled} className="grid grid-cols-1 gap-2.5 sm:grid-cols-2" aria-describedby="desktop-setup-help">
    <legend className="mb-3 text-xs font-medium text-gray-500">How should your team’s desktop app work?</legend>
    {([
      { id: "flexible", icon: SlidersHorizontal, title: "Flexible", copy: "Let members add their own tools, models, and workspaces." },
      { id: "restricted", icon: LockKeyhole, title: "Set up Restricted", copy: "Keep desktop access consistent with a policy you control." },
    ] satisfies Array<{ id: DesktopSetup; icon: typeof Laptop; title: string; copy: string }>).map((option) => <label key={option.id} className={`relative flex cursor-pointer items-start gap-3 rounded-xl border p-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-gray-600 ${mode === option.id ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white hover:border-gray-400"}`}>
      <input type="radio" name="desktop-setup" value={option.id} checked={mode === option.id} onChange={() => onChange(option.id)} className="sr-only" />
      <span><span className="mb-3 flex items-center justify-between text-gray-600"><option.icon className="h-4 w-4" /><span aria-hidden="true" className={`grid size-4 place-items-center rounded-full border ${mode === option.id ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"}`}>{mode === option.id ? <Check size={10} /> : null}</span></span><span className="text-[13px] font-medium text-gray-950">{option.title}</span><span className="mt-1 block text-[11px] leading-5 text-gray-500">{option.copy}</span></span>
    </label>)}
    <p id="desktop-setup-help" className="text-[11px] leading-5 text-gray-500 sm:col-span-2">Restricted requires Enterprise. You’ll review the desktop permissions before saving; restrictions aren’t applied yet.</p>
  </fieldset>;
}
